using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LimeIoT.Client;

static class ControlLiveChecks {
    static void Check(bool value,string name){if(!value)throw new InvalidOperationException(name);}
    public static async Task Run() {
        string Env(string name)=>Environment.GetEnvironmentVariable(name)??throw new InvalidOperationException("missing fixture setting "+name);
        var origin=Env("LIMEIOT_TEST_CONTROL_ORIGIN");var directory=Env("LIMEIOT_NATIVE_CHECK_DIRECTORY");var space=Env("LIMEIOT_NATIVE_CHECK_SPACE");
        Check(new Uri(origin).Scheme=="https","real fixture requires HTTPS");var store=new ControlFileStore(directory);
        using(var untrusted=new ControlClient(origin,store)){
            try{await untrusted.BeginAuthorizationAsync();throw new InvalidOperationException("untrusted fixture CA accepted");}catch(HttpRequestException){}
        }
        using var ca=X509CertificateLoader.LoadCertificateFromFile(Env("LIMEIOT_TEST_CONTROL_CA_FILE"));
        HttpMessageHandler Transport()=>new HttpClientHandler {
            AllowAutoRedirect=false,UseCookies=false,
            ServerCertificateCustomValidationCallback=(request,certificate,_,errors)=>{
                if(request.RequestUri?.GetLeftPart(UriPartial.Authority)!=origin||certificate is null||(errors&(SslPolicyErrors.RemoteCertificateNameMismatch|SslPolicyErrors.RemoteCertificateNotAvailable))!=0)return false;
                using var chain=new X509Chain();chain.ChainPolicy.TrustMode=X509ChainTrustMode.CustomRootTrust;chain.ChainPolicy.CustomTrustStore.Add(ca);chain.ChainPolicy.RevocationMode=X509RevocationMode.NoCheck;
                chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));return chain.Build(certificate);
            }
        };
        var json=new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.SnakeCaseLower};
        async Task Write(string name,object value)=>await ControlFileStore.Write(Path.Combine(directory,name),JsonSerializer.Serialize(value,json));
        async Task Wait(string name){for(var i=0;i<300;i++){if(File.Exists(Path.Combine(directory,name)))return;await Task.Delay(100);}throw new InvalidOperationException("fixture marker timeout "+name);}
        using var client=new ControlClient(origin,store,Transport());var login=await client.BeginAuthorizationAsync();await Write("login.json",login);
        var authorization=await client.PollAuthorizationAsync();
        for(var i=0;i<30&&authorization.Status=="pending";i++){await Task.Delay(3000);authorization=await client.PollAuthorizationAsync();}
        Check(authorization.Status=="approved"&&authorization.Session is not null,"real browser approval");
        using var restored=new ControlClient(origin,store,Transport());Check((await restored.RestoreSessionAsync()).Principal.PrincipalId==authorization.Session!.Principal.PrincipalId,"real stored identity");
        Check((await restored.SpacesAsync()).Any(s=>s.SpaceId==space),"explicit owner space");
        var gateway=(await restored.GatewaysAsync(space)).Single(g=>g.Active);var page=await restored.DevicesAsync(space);var lamp=page.Items.Single(d=>d.Id=="device-lamp");
        Check(page.BindingRevision==gateway.Revision,"current remote binding");var action=Environment.GetEnvironmentVariable("LIMEIOT_NATIVE_CHECK_ACTION")=="1";
        var model=await restored.ModelAsync(space,lamp.ModelRevision);Check(model["services"]!.AsArray().Any(s=>s!["id"]!.ToString()==(action?"remote":"light")),"real model projection");
        var record=await restored.PrepareCommandAsync(space,gateway,lamp,action?"remote.press":"light.brightness",action?new JsonObject{{"key","home"}}:JsonValue.Create(37),action?"action.invoke":"property.set");
        await Write("operation.json",record);await Wait("send");
        try{await restored.SubmitCommandAsync(record.Id);throw new InvalidOperationException("expected real lost response");}catch(HttpRequestException){}catch(TaskCanceledException){}
        await Write("unknown","unknown");await Wait("recover");using var recovered=new ControlClient(origin,store,Transport());var outcome=await recovered.SubmitCommandAsync(record.Id);
        for(var i=0;i<20&&outcome.Result?.Terminal!=true;i++){await Task.Delay(200);outcome=await recovered.ResolveCommandAsync(record.Id,true);}
        Check(outcome.Result?.Status=="confirmed"&&outcome.Id==record.Id,"real original command confirmation");
        if(action)Check(outcome.Result!.LocalResult!["evidence"]!["completion"]!.ToString()=="submitted","real action completion scope");
        await recovered.LogoutAsync();using var after=new ControlClient(origin,store,Transport());
        try{await after.CommandRecordsAsync();throw new InvalidOperationException("logged out records exposed");}catch(GatewayException error)when(error.Code=="unauthenticated"){}
        Console.WriteLine("{\"dotnet_real_cloud\":true,\"real_https\":true,\"untrusted_ca_rejected\":true,\"hardware\":false,\"native_app\":false}");
    }
}

// 仅用于隔离测试；真实 Windows 宿主须提供系统安全存储。
sealed class ControlFileStore(string directory):ISessionStore {
    string FileFor(string scope)=>Path.Combine(directory,Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(scope)))+".json");
    public async Task<string?> LoadAsync(string scope,CancellationToken cancellation=default){var path=FileFor(scope);return File.Exists(path)?await File.ReadAllTextAsync(path,cancellation):null;}
    public Task SaveAsync(string scope,string? value,CancellationToken cancellation=default)=>Write(FileFor(scope),value??"",cancellation);
    internal static async Task Write(string path,string value,CancellationToken cancellation=default) {
        var temporary=path+".pending";var options=new FileStreamOptions{Mode=FileMode.Create,Access=FileAccess.Write,Share=FileShare.None,Options=FileOptions.WriteThrough};
        if(!OperatingSystem.IsWindows())options.UnixCreateMode=UnixFileMode.UserRead|UnixFileMode.UserWrite;
        await using(var file=new FileStream(temporary,options)){await file.WriteAsync(Encoding.UTF8.GetBytes(value),cancellation);file.Flush(true);}
        File.Move(temporary,path,true);
    }
}
