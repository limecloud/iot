using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Text.Json.Serialization;

namespace LimeIoT.Client;

public interface ISessionStore {
    Task<string?> LoadAsync(string scope,CancellationToken cancellation=default);
    Task SaveAsync(string scope,string? value,CancellationToken cancellation=default);
}
public sealed class GatewayException(string code,int status=0):Exception(code) { public string Code {get;}=code; public int Status {get;}=status; }
public sealed record Device(string Id,string ModelRevision,bool Ready,JsonObject? Reported=null);
public sealed record Snapshot(string Space,IReadOnlyList<Device> Devices,JsonObject Models);
public sealed record CommandIntent(string Key,string DeviceId,string ModelRevision,string ExpiresAt,JsonObject Operation) {
    public static CommandIntent Create(Device device,string path,JsonNode value,string type="action.invoke") {
        if(type is not ("action.invoke" or "property.set"))throw new GatewayException("invalid_operation");
        return new(Guid.NewGuid().ToString(),device.Id,device.ModelRevision,DateTimeOffset.UtcNow.AddSeconds(5).ToString("O"),new JsonObject{{"type",type},{"path",path},{"value",value.DeepClone()}});
    }
    [JsonIgnore] public JsonObject Input => new(){{"device_id",DeviceId},{"model_revision",ModelRevision},{"expires_at",ExpiresAt},{"operation",Operation.DeepClone()}};
}
public sealed record CommandReceipt(string Id,string Status,JsonObject Document);
internal sealed record SavedSession(string Cookie,string Csrf);

/// <summary>本地 HTTPS 用户会话与命令恢复；不持有设备私钥，不负责重试副作用。</summary>
public sealed class GatewayClient:IDisposable {
    public string Origin {get;}
    private readonly HttpClient http;
    private readonly ISessionStore storage;
    private SavedSession? session;
    private readonly SemaphoreSlim sessionGate=new(1,1);
    private static readonly Regex Identifier=new("^[A-Za-z0-9_-]{1,128}$",RegexOptions.CultureInvariant);
    public GatewayClient(string origin,ISessionStore storage,HttpMessageHandler? transport=null,bool allowLoopbackHttp=false) {
        if(!Uri.TryCreate(origin,UriKind.Absolute,out var uri)||uri.UserInfo!=""||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""||origin!=uri.GetLeftPart(UriPartial.Authority)||!(uri.Scheme=="https"||allowLoopbackHttp&&uri.Scheme=="http"&&uri.IsLoopback))throw new GatewayException("invalid_endpoint");
        Origin=origin;this.storage=storage;
        http=new HttpClient(transport??new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=TimeSpan.FromSeconds(12)};
    }
    private static string Segment(string value)=>Uri.EscapeDataString(value);
    internal static string SpacePath(string space) {if(!Identifier.IsMatch(space))throw new GatewayException("invalid_space");return "/api/v1/spaces/"+Segment(space);}
    private async Task<(JsonObject Body,HttpResponseMessage Response)> RequestAsync(string path,HttpMethod method,JsonObject? body=null,string? key=null,bool authenticated=true,CancellationToken cancellation=default) {
        if(authenticated&&session is null)throw new GatewayException("unauthenticated",401);
        using var request=new HttpRequestMessage(method,Origin+path);
        request.Headers.Add("Origin",Origin);
        if(session is not null){request.Headers.Add("Cookie",session.Cookie);request.Headers.Add("X-CSRF-Token",session.Csrf);}
        if(key is not null)request.Headers.Add("Idempotency-Key",key);
        if(body is not null)request.Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json");
        var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);
        try {
            using var stream=await response.Content.ReadAsStreamAsync(cancellation);using var buffer=new MemoryStream();
            var chunk=new byte[8192];int size;
            while((size=await stream.ReadAsync(chunk,cancellation))>0){if(buffer.Length+size>2_000_000)throw new GatewayException("invalid_response");buffer.Write(chunk,0,size);}
            JsonObject document;
            try{document=buffer.Length==0?new():JsonNode.Parse(buffer.ToArray(),documentOptions:new JsonDocumentOptions{MaxDepth=32})?.AsObject()??throw new JsonException();}catch(JsonException){throw new GatewayException("invalid_response");}
            if(!response.IsSuccessStatusCode){var code=document["error"]?["code"]?.GetValue<string>()??"request_failed";if(!Regex.IsMatch(code,"^[a-z0-9_]{1,80}$"))code="request_failed";throw new GatewayException(code,(int)response.StatusCode);}
            return(document,response);
        }catch{response.Dispose();throw;}
    }
    internal async Task<JsonObject> CallAsync(string path,HttpMethod? method=null,JsonObject? body=null,string? key=null,CancellationToken cancellation=default){var result=await RequestAsync(path,method??HttpMethod.Get,body,key,cancellation:cancellation);using(result.Response)return result.Body;}
    public async Task LoginAsync(string token,CancellationToken cancellation=default) {
        await sessionGate.WaitAsync(cancellation);try{
            session=null;
            var result=await RequestAsync("/api/v1/auth/session",HttpMethod.Post,new(){{"token",token}},authenticated:false,cancellation:cancellation);
            using var response=result.Response;
            if(!response.Headers.TryGetValues("Set-Cookie",out var cookies))throw new GatewayException("invalid_response");
            var prefix=Origin.StartsWith("https:",StringComparison.Ordinal)?"__Host-limeiot_session=":"limeiot_session=";
            var cookie=cookies.Select(v=>v.Split(';')[0]).SingleOrDefault(v=>v.StartsWith(prefix,StringComparison.Ordinal));
            if(cookie is null||cookie.Length!=prefix.Length+64)throw new GatewayException("invalid_response");
            var csrf=result.Body["csrf_token"]?.GetValue<string>()??throw new GatewayException("invalid_response");
            var saved=new SavedSession(cookie,csrf);await storage.SaveAsync(Origin,JsonSerializer.Serialize(saved),cancellation);session=saved;
        }finally{sessionGate.Release();}
    }
    public async Task RestoreAsync(CancellationToken cancellation=default){
        var data=await storage.LoadAsync(Origin,cancellation)??throw new GatewayException("unauthenticated",401);
        session=JsonSerializer.Deserialize<SavedSession>(data)??throw new GatewayException("invalid_response");
        try{await CallAsync("/api/v1/auth/session",cancellation:cancellation);}catch{session=null;throw;}
    }
    public async Task LogoutAsync(CancellationToken cancellation=default){await CallAsync("/api/v1/auth/logout",HttpMethod.Post,new(),cancellation:cancellation);session=null;await storage.SaveAsync(Origin,null,cancellation);}
    public async Task<IReadOnlyList<string>> SpacesAsync(CancellationToken cancellation=default){var result=await CallAsync("/api/v1/spaces",cancellation:cancellation);return result["items"]!.AsArray().Select(v=>v!["space_id"]!.GetValue<string>()).ToArray();}
    public async Task<Snapshot> SnapshotAsync(string space,CancellationToken cancellation=default){
        var path=SpacePath(space);var capabilities=await CallAsync(path+"/capabilities",cancellation:cancellation);var devices=await CallAsync(path+"/devices",cancellation:cancellation);
        var items=devices["items"]!.AsArray().Select(v=>new Device(v!["device_id"]!.GetValue<string>(),v["model_revision"]!.GetValue<string>(),v["ready"]!.GetValue<bool>(),v["reported"] is null?null:(JsonObject)v["reported"]!.AsObject().DeepClone())).ToArray();
        return new Snapshot(space,items,(JsonObject)capabilities["models"]!.DeepClone());
    }
    public async Task<CommandReceipt> CreateAsync(string space,CommandIntent intent,CancellationToken cancellation=default)=>Validate(await CallAsync(SpacePath(space)+"/commands",HttpMethod.Post,intent.Input,intent.Key,cancellation),space,intent);
    public async Task<CommandReceipt> ResolveAsync(string space,CommandIntent intent,CancellationToken cancellation=default)=>Validate(await CallAsync(SpacePath(space)+"/commands/by-key/"+Segment(intent.Key),cancellation:cancellation),space,intent);
    public static CommandReceipt Validate(JsonObject document,string space,CommandIntent intent){
        try{
            var id=document["command_id"]!.GetValue<string>();var status=document["status"]!.GetValue<string>();var request=document["request"]!.AsObject();
            if(!Regex.IsMatch(id,"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")||!new[]{"accepted","dispatched","confirmed","unknown","failed","expired","rejected"}.Contains(status)||!Regex.IsMatch(document["request_digest"]!.GetValue<string>(),"^sha256:[a-f0-9]{64}$"))throw new JsonException();
            if(!request.Select(p=>p.Key).Order().SequenceEqual(new[]{"device_id","expires_at","idempotency_key","model_revision","operation","space_id"})||request["space_id"]!.GetValue<string>()!=space||request["device_id"]!.GetValue<string>()!=intent.DeviceId||request["model_revision"]!.GetValue<string>()!=intent.ModelRevision||request["idempotency_key"]!.GetValue<string>()!=intent.Key||DateTimeOffset.Parse(request["expires_at"]!.GetValue<string>())!=DateTimeOffset.Parse(intent.ExpiresAt)||!JsonNode.DeepEquals(request["operation"],intent.Operation))throw new JsonException();
            if(!intent.Operation.Select(p=>p.Key).ToHashSet().SetEquals(["type","path","value"])||intent.Operation["type"]!.GetValue<string>() is not ("property.set" or "action.invoke"))throw new JsonException();
            if(status=="confirmed"){
                if(document["error"] is not null)throw new JsonException();var evidence=document["evidence"]!.AsObject();
                if(intent.Operation["type"]!.GetValue<string>()=="property.set"){
                    var path=intent.Operation["path"]!.GetValue<string>();
                    if(evidence["type"]!.GetValue<string>()!="device_result"||evidence["reported"] is not JsonObject reported||!reported.ContainsKey(path)||!JsonNode.DeepEquals(reported[path],intent.Operation["value"]))throw new JsonException();
                }else{
                    if(!evidence.Select(p=>p.Key).ToHashSet().SetEquals(["type","path","input_digest","output","completion","observed_at"])||evidence["type"]!.GetValue<string>()!="action_result"||evidence["path"]!.GetValue<string>()!=intent.Operation["path"]!.GetValue<string>()||!Regex.IsMatch(evidence["input_digest"]!.GetValue<string>(),"^sha256:[a-f0-9]{64}$")||evidence["output"] is null||!new[]{"submitted","observed"}.Contains(evidence["completion"]!.GetValue<string>()))throw new JsonException();
                    var observed=DateTimeOffset.Parse(evidence["observed_at"]!.GetValue<string>());if(observed<DateTimeOffset.Parse(intent.ExpiresAt).AddSeconds(-32)||observed>DateTimeOffset.UtcNow.AddSeconds(2))throw new JsonException();
                }
            }
            return new(id,status,document);
        }catch(Exception error)when(error is not GatewayException){throw new GatewayException("invalid_response");}
    }
    public void Dispose(){http.Dispose();sessionGate.Dispose();}
}
