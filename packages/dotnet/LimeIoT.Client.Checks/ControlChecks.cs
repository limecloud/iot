using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LimeIoT.Client;

static class ControlChecks {
    static void Check(bool value,string name){if(!value)throw new InvalidOperationException(name);}
    static async Task Expect(Func<Task> action,string code) {
        try{await action();throw new InvalidOperationException("expected "+code);}catch(GatewayException error)when(error.Code==code){}
    }
    static ControlClient Client(ControlStore store,ControlFixture fixture)=>new("https://control.example",store,fixture);
    static readonly ControlGateway Gateway=new("gw-a","space-a","local-space","owner",["commands.write"],"revision-a",true);
    static readonly Device Desktop=new("desktop","sha256:"+new string('a',64),true);
    static async Task Login(ControlClient client,string platform="windows") {
        var login=await client.BeginAuthorizationAsync(platform);
        Check(!login.ToString().Contains(login.UserCode,StringComparison.Ordinal),"login presentation redacted");
        Check((await client.PollAuthorizationAsync()).Session?.Principal.PrincipalId=="owner","independent child session");
    }
    static Task<ControlCommandRecord> Prepare(ControlClient client,string type="action.invoke",string space="space-a")=>client.PrepareCommandAsync(space,Gateway with{SpaceId=space},Desktop,type=="action.invoke"?"link.exchange":"light.brightness",type=="action.invoke"?new JsonObject{{"text","你好"}}:JsonValue.Create(37),type);
    public static async Task Run() {
        foreach(var origin in new[]{"http://control.example","https://user@control.example","https://control.example/","https://control.example/path","https://control.example?key=x","http://localhost"}) {
            try{using var invalid=new ControlClient(origin,new ControlStore(),allowLoopbackHttp:true);throw new InvalidOperationException("origin accepted");}catch(GatewayException error)when(error.Code=="invalid_endpoint"){}
        }
        foreach(var platform in new[]{"ios","android","macos","windows"}) {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);
            store.Fail=true;try{await client.BeginAuthorizationAsync(platform);throw new InvalidOperationException("storage failure accepted");}catch(IOException){}
            Check(fixture.Calls.Count==0,"proof storage failure sends zero requests");store.Fail=false;fixture.LoseStart=true;
            try{await client.BeginAuthorizationAsync(platform);throw new InvalidOperationException("response loss expected");}catch(HttpRequestException){}
            using var recovered=Client(store,fixture);var login=await recovered.BeginAuthorizationAsync(platform);
            var starts=fixture.Calls.Where(c=>c.Path=="/api/native/v1/authorizations").ToArray();
            Check(starts.Length==2&&JsonNode.DeepEquals(starts[0].Body,starts[1].Body),"same key and PKCE after restart");
            var saved=JsonNode.Parse(store.Values.Values.Single())!;var verifier=saved["pending"]!["proof"]!["code_verifier"]!.GetValue<string>();
            var challenge=Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(verifier))).TrimEnd('=').Replace('+','-').Replace('/','_');
            Check(starts[0].Body!["code_challenge"]!.ToString()==challenge&&starts[0].Body!["platform"]!.ToString()==platform,"PKCE S256 and platform");
            Check(!login.ToString().Contains(login.UserCode,StringComparison.Ordinal),"authorization code redaction");
            await recovered.PollAuthorizationAsync();using var restored=Client(store,fixture);
            Check((await restored.RestoreSessionAsync()).Principal.PrincipalId=="owner","durable session");
            Check((await restored.SpacesAsync()).Single().SpaceId=="space-a","cloud spaces");
            Check((await restored.GatewaysAsync("space-a")).Single().GatewayId=="gw-a","cloud bindings");
            Check((await restored.DevicesAsync("space-a")).Items.Single().Id=="desktop","device projection");
            Check((await restored.ModelAsync("space-a",Desktop.ModelRevision))["services"] is JsonArray,"model projection");
            fixture.Unavailable=true;await Expect(()=>restored.RestoreSessionAsync(),"identity_unavailable");fixture.Unavailable=false;
            await restored.RestoreSessionAsync();fixture.Unavailable=true;await restored.LogoutAsync();fixture.Unavailable=false;
            await Expect(()=>restored.RestoreSessionAsync(),"unauthenticated");
            foreach(var call in fixture.Calls.Where(c=>c.Path.StartsWith("/api/native/",StringComparison.Ordinal)))Check(call.Cookie is null&&call.Origin is null&&call.Authorization is null,"native calls isolate browser credentials");
            Check(store.Values.Keys.All(k=>k=="limeiot.control:v1:https://control.example"),"origin scoped storage");
        }
        foreach(var poison in new[]{"redirect","origin","audience","principal","pending","expiry","csrf","session_expiry"}) {
            var store=new ControlStore();var fixture=new ControlFixture{Poison=poison};using var client=Client(store,fixture);
            await Expect(async()=>{await client.BeginAuthorizationAsync();await client.PollAuthorizationAsync();},"invalid_response");
            if(poison is "origin" or "audience" or "pending" or "expiry")Check(fixture.Calls.All(c=>c.Cookie is null),"unvalidated material never used");
            Check(JsonNode.Parse(store.Values.Values.Single())!["material"] is null,"poisoned material not persisted");
        }
        {
            var store=new ControlStore{DropWrites=true};var fixture=new ControlFixture();using var client=Client(store,fixture);
            await Expect(()=>client.BeginAuthorizationAsync(),"storage_verification_failed");Check(fixture.Calls.Count==0,"readback failure sends no requests");
        }
        {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);await Login(client);
            await client.CancelAuthorizationAsync();await Expect(()=>client.RestoreSessionAsync(),"unauthenticated");Check(!await client.HasPendingAuthorizationAsync(),"cancel removes local proof after revocation");
        }
        foreach(var type in new[]{"property.set","action.invoke"}) {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);await Login(client);
            store.Fail=true;try{await Prepare(client,type);throw new InvalidOperationException("prepare save failure accepted");}catch(IOException){}store.Fail=false;
            Check(fixture.Creates==0,"prepare failure sends zero creates");
            var prepared=await Prepare(client,type);prepared.Reference.Request.Operation["value"]=new JsonObject{{"caller","mutated"}};
            Check((await client.CommandRecordsAsync()).Single().Reference.Request.Operation["value"]?.ToJsonString()!=prepared.Reference.Request.Operation["value"]?.ToJsonString(),"returned JSON cannot mutate durable original");
            store.Fail=true;try{await client.SubmitCommandAsync(prepared.Id);throw new InvalidOperationException("attempt save failure accepted");}catch(IOException){}store.Fail=false;
            Check(fixture.Creates==0,"attempt save failure sends zero creates");fixture.LoseCommand=true;
            try{await client.SubmitCommandAsync(prepared.Id);throw new InvalidOperationException("lost command response expected");}catch(HttpRequestException){}
            using var recovered=Client(store,fixture);fixture.MissingCommand=true;await Expect(()=>recovered.SubmitCommandAsync(prepared.Id),"not_found");fixture.MissingCommand=false;
            Check(fixture.Creates==1,"404 never resubmits original create");await Expect(()=>recovered.ForgetCommandAsync(prepared.Id),"operation_not_terminal");
            fixture.FailReconcile=true;await Expect(()=>recovered.ResolveCommandAsync(prepared.Id,true),"gateway_offline");
            Check((await recovered.CommandRecordsAsync()).Single().Result?.RemoteId is not null,"GET remote identity saved before failed reconcile");fixture.FailReconcile=false;
            var result=await recovered.ResolveCommandAsync(prepared.Id,true);Check(result.Result?.Status=="confirmed"&&fixture.Creates==1,"confirmed original command with single create");
            fixture.Status="unknown";await Expect(()=>recovered.ResolveCommandAsync(prepared.Id),"invalid_response");fixture.Status="confirmed";
            await recovered.ForgetCommandAsync(prepared.Id);Check((await recovered.CommandRecordsAsync()).Count==0,"terminal command can be forgotten");
        }
        foreach(var poison in new[]{"principal","request","local_request","evidence","action_type","action_path","action_digest","action_scope","action_output","action_missing","action_time","action_future","action_extra","action_error"}) {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);await Login(client);
            var record=await Prepare(client);fixture.RemotePoison=poison;fixture.Status="confirmed";
            await Expect(()=>client.SubmitCommandAsync(record.Id),"invalid_response");
            Check((await client.CommandRecordsAsync()).Single().Result is null,"mismatched receipt is not accepted");
        }
        {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);await Login(client);
            var first=await Prepare(client);await Prepare(client,space:"space-b");Check((await client.CommandRecordsAsync()).Count==2&&(await client.CommandRecordsAsync("space-a")).Count==1,"all spaces restored without selection");
            await client.ForgetCommandAsync(first.Id);fixture.RejectCommand=true;var record=(await client.CommandRecordsAsync()).Single();
            await Expect(()=>client.SubmitCommandAsync(record.Id),"forbidden");Check((await client.SubmitCommandAsync(record.Id)).Rejection=="forbidden"&&fixture.Creates==1,"definitive rejection does not retry");
            fixture.Revoked=true;await Expect(()=>client.RestoreSessionAsync(),"unauthenticated");
            var saved=JsonNode.Parse(store.Values.Values.Single())!;Check(saved["material"] is null&&saved["pending"] is not null&&saved["operations"]!.AsArray().Count==1,"401 clears material and preserves recovery records");
        }
        {
            var store=new ControlStore();var fixture=new ControlFixture();using var client=Client(store,fixture);await Login(client);
            var record=await Prepare(client);using var cancellation=new CancellationTokenSource();cancellation.Cancel();
            try{await client.SubmitCommandAsync(record.Id,cancellation.Token);throw new InvalidOperationException("cancel ignored");}catch(OperationCanceledException){}
            Check(fixture.Creates==0&&(await client.CommandRecordsAsync()).Single().IsPrepared,"cancel before submit preserves unsent preparation");
            var saved=JsonNode.Parse(store.Values.Values.Single())!.AsObject();var operation=saved["operations"]![0]!.DeepClone();
            var operations=saved["operations"]!.AsArray();for(var i=1;i<128;i++){var copy=operation.DeepClone();copy["reference"]!["request"]!["request_key"]=i.ToString("x64");operations.Add(copy);}store.Values[store.Values.Keys.Single()]=saved.ToJsonString();
            await Expect(()=>Prepare(client),"local_operation_capacity");Check((await client.CommandRecordsAsync()).Count==128,"capacity does not silently delete unknown records");
        }
    }
}

sealed class ControlStore:ISessionStore {
    public Dictionary<string,string> Values {get;}=[];public bool Fail;public bool DropWrites;
    public Task<string?> LoadAsync(string scope,CancellationToken cancellation=default)=>Task.FromResult(Values.GetValueOrDefault(scope));
    public Task SaveAsync(string scope,string? value,CancellationToken cancellation=default) {
        if(Fail)throw new IOException("fixture storage unavailable");
        if(!DropWrites){if(value is null)Values.Remove(scope);else Values[scope]=value;}return Task.CompletedTask;
    }
}
sealed record ControlCall(string Path,JsonObject? Body,string? Cookie,string? Origin,string? Authorization);
sealed class ControlFixture:HttpMessageHandler {
    public List<ControlCall> Calls {get;}=[];public bool LoseStart;public bool LoseCommand;public bool MissingCommand;public bool Unavailable;public bool Revoked;public bool FailReconcile;public bool RejectCommand;
    public string? Poison;public string? RemotePoison;public string Status="unknown";public int Creates;
    JsonObject? original;
    const string Origin="https://control.example";
    static readonly string Token=new('c',64),Authorization="na-"+new string('b',64),RemoteId="remote-"+new string('d',64);
    readonly string expiry=DateTimeOffset.UtcNow.AddMinutes(5).ToString("O"),sessionExpiry=DateTimeOffset.UtcNow.AddSeconds(3500).ToString("O");
    static string Csrf=>Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("limeiot-csrf:console:"+Token)));
    JsonObject Remote() {
        var input=original!.DeepClone().AsObject();var operation=input["operation"]!.AsObject();
        var result=new JsonObject{{"remote_id",RemoteId},{"space_id","space-a"},{"principal_id","owner"},{"local_space_id","local-space"},{"request_digest",new string('a',64)},{"request",input},{"status",Status},{"local_result",null}};
        if(RemotePoison=="principal")result["principal_id"]="other";
        if(RemotePoison=="request")input["device_id"]="other";
        if(Status!="confirmed")return result;
        var local=new JsonObject{{"command_id","cmd-original"},{"request_digest","sha256:"+new string('b',64)},{"status","confirmed"},{"error",null},{"request",new JsonObject{{"space_id","local-space"},{"idempotency_key",RemoteId},{"device_id",input["device_id"]!.DeepClone()},{"model_revision",input["model_revision"]!.DeepClone()},{"expires_at",input["expires_at"]!.DeepClone()},{"operation",operation.DeepClone()}}}};
        var evidence=new JsonObject{{"type","device_result"},{"reported",new JsonObject{{operation["path"]!.ToString(),operation["value"]?.DeepClone()}}}};
        if(operation["type"]!.ToString()=="action.invoke") {
            evidence=new JsonObject{{"type","action_result"},{"path",operation["path"]!.DeepClone()},{"input_digest","sha256:"+new string('b',64)},{"output",new JsonObject()},{"completion","submitted"},{"observed_at",DateTimeOffset.UtcNow.ToString("O")}};
            switch(RemotePoison) {
                case "action_type":evidence["type"]="device_result";break;
                case "action_path":evidence["path"]="other.press";break;
                case "action_digest":evidence["input_digest"]="invalid";break;
                case "action_scope":evidence["completion"]="completed";break;
                case "action_output":evidence["output"]=null;break;
                case "action_missing":evidence.Remove("output");break;
                case "action_time":evidence["observed_at"]=DateTimeOffset.UtcNow.AddSeconds(-60).ToString("O");break;
                case "action_future":evidence["observed_at"]=DateTimeOffset.UtcNow.AddSeconds(60).ToString("O");break;
                case "action_extra":evidence["extra"]=true;break;
                case "action_error":local["error"]="execution_failed";break;
            }
        }
        local["evidence"]=RemotePoison=="evidence"?null:evidence;if(RemotePoison=="local_request")local["request"]=null;result["local_result"]=local;return result;
    }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation) {
        var path=request.RequestUri!.AbsolutePath;var input=request.Content is null?null:JsonNode.Parse(await request.Content.ReadAsStringAsync(cancellation))!.AsObject();
        string? Header(string name)=>request.Headers.TryGetValues(name,out var values)?values.Single():null;
        Calls.Add(new(path,input,Header("Cookie"),Header("Origin"),Header("Authorization")));
        if(path.StartsWith("/api/console/",StringComparison.Ordinal)&&!(Header("Cookie")=="__Host-limeiot_console="+Token&&Header("Origin")==Origin&&Header("X-CSRF-Token")==Csrf))throw new InvalidOperationException("missing console proof");
        var status=HttpStatusCode.OK;JsonObject body;
        if(path=="/api/native/v1/authorizations") {
            if(LoseStart){LoseStart=false;throw new HttpRequestException("response_lost");}
            body=new(){{"authorization_id",Authorization},{"user_code","ABCDEF12"},{"verification_uri",Poison=="redirect"?"https://other.invalid/console":Origin+"/console/?native="+Authorization},{"expires_at",expiry},{"interval_seconds",3},{"status","pending"}};
        }else if(path.EndsWith("/authorizations/poll",StringComparison.Ordinal)) {
            var material=new JsonObject{{"version",1},{"origin",Poison=="origin"?"https://other.invalid":Origin},{"audience",Poison=="audience"?"admin":"console"},{"session",Token},{"principal_id","owner"},{"expires_at",Poison=="expiry"?DateTimeOffset.UtcNow.AddHours(2).ToString("O"):sessionExpiry}};
            body=new(){{"status",Poison=="pending"?"pending":"approved"},{"expires_at",expiry},{"material",material}};
        }else if(path.EndsWith("/authorizations/cancel",StringComparison.Ordinal)){Revoked=true;body=new(){{"status","cancelled"}};}
        else if(path.EndsWith("/auth/logout",StringComparison.Ordinal)){Revoked=true;body=new(){{"logged_out",true}};}
        else if(path.EndsWith("/auth/session",StringComparison.Ordinal)) {
            if(Revoked){status=HttpStatusCode.Unauthorized;body=new(){{"error",new JsonObject{{"code","identity_rejected"}}}};}
            else if(Unavailable){status=HttpStatusCode.ServiceUnavailable;body=new(){{"error",new JsonObject{{"code","identity_unavailable"}}}};}
            else body=new(){{"audience","console"},{"principal",new JsonObject{{"principal_id",Poison=="principal"?"other":"owner"},{"name","测试账号"}}},{"csrf_token",Poison=="csrf"?"wrong":Csrf},{"expires_at",Poison=="session_expiry"?expiry:sessionExpiry}};
        }else if(path.EndsWith("/remote-commands",StringComparison.Ordinal)&&request.Method==HttpMethod.Post) {
            Creates++;if(RejectCommand){status=HttpStatusCode.Forbidden;body=new(){{"error",new JsonObject{{"code","forbidden"}}}};}
            else {original=input!.DeepClone().AsObject();if(LoseCommand){LoseCommand=false;throw new HttpRequestException("response_lost");}body=Remote();}
        }else if(path.Contains("/remote-commands/by-key/",StringComparison.Ordinal)) {
            if(MissingCommand){status=HttpStatusCode.NotFound;body=new(){{"error",new JsonObject{{"code","not_found"}}}};}else body=Remote();
        }else if(path.EndsWith("/reconcile",StringComparison.Ordinal)) {
            if(FailReconcile){status=HttpStatusCode.ServiceUnavailable;body=new(){{"error",new JsonObject{{"code","gateway_offline"}}}};}else{Status="confirmed";body=Remote();}
        }else if(path=="/api/console/v1/spaces")body=new(){{"spaces",new JsonArray(new JsonObject{{"space_id","space-a"},{"name","测试家庭"}})}};
        else if(path.EndsWith("/gateways",StringComparison.Ordinal))body=JsonNode.Parse("{\"gateways\":[{\"gateway_id\":\"gw-a\",\"space_id\":\"space-a\",\"local_space_id\":\"local-space\",\"principal_id\":\"owner\",\"scopes\":[\"commands.write\"],\"revision\":\"revision-a\",\"active\":true}]}")!.AsObject();
        else if(path.EndsWith("/devices",StringComparison.Ordinal))body=new(){{"items",new JsonArray(new JsonObject{{"device_id","desktop"},{"model_revision","sha256:"+new string('a',64)},{"ready",true}})},{"next",null},{"binding_revision","revision-a"}};
        else if(path.Contains("/model-releases/",StringComparison.Ordinal))body=new(){{"revision","sha256:"+new string('a',64)},{"model",new JsonObject{{"services",new JsonArray()}}}};
        else throw new InvalidOperationException("unexpected fixture request");
        return new HttpResponseMessage(status){RequestMessage=request,Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json")};
    }
}
