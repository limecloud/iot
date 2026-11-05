using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LimeIoT.Client;

/// <summary>原生云授权及受限远程命令；发出过的命令只查询原键，不自动补发。</summary>
public sealed class ControlClient:IDisposable {
    public string Origin {get;}
    private readonly ISessionStore storage;
    private readonly HttpClient http;
    private readonly SemaphoreSlim gate=new(1,1);
    private string StorageKey=>"limeiot.control:v1:"+Origin;
    private static readonly JsonSerializerOptions Json=new(){PropertyNamingPolicy=JsonNamingPolicy.SnakeCaseLower,MaxDepth=32};
    private static bool Matches(string? value,string pattern)=>value is not null&&Regex.IsMatch(value,"\\A(?:"+pattern+")\\z",RegexOptions.CultureInvariant);
    private static bool Platform(string value)=>value is "ios" or "android" or "macos" or "windows";
    private static string RandomKey()=>Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
    private static byte[] Hash(string value)=>SHA256.HashData(Encoding.UTF8.GetBytes(value));
    private static string Csrf(ControlMaterial material)=>Convert.ToHexStringLower(Hash("limeiot-csrf:console:"+material.Session));
    private static string Segment(string value)=>Uri.EscapeDataString(value);
    private static DateTimeOffset Date(string value) {
        if(!Matches(value,@"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})")||!DateTimeOffset.TryParse(value,CultureInfo.InvariantCulture,DateTimeStyles.None,out var date))throw new GatewayException("invalid_response");
        return date;
    }
    private static T Decode<T>(string value) {
        try{return JsonSerializer.Deserialize<T>(value,Json)??throw new JsonException();}
        catch(JsonException){throw new GatewayException("invalid_response");}
    }
    private static bool Equal<T>(T left,T right)=>JsonNode.DeepEquals(JsonSerializer.SerializeToNode(left,Json),JsonSerializer.SerializeToNode(right,Json));
    private async Task<T> Locked<T>(Func<Task<T>> action,CancellationToken cancellation) {
        if(!await gate.WaitAsync(0,cancellation))throw new GatewayException("busy");
        try{return await action();}finally{gate.Release();}
    }
    public ControlClient(string origin,ISessionStore storage,HttpMessageHandler? transport=null,bool allowLoopbackHttp=false) {
        if(!Uri.TryCreate(origin,UriKind.Absolute,out var uri)||uri.UserInfo!=""||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""||origin!=uri.GetLeftPart(UriPartial.Authority)||!(uri.Scheme=="https"||allowLoopbackHttp&&uri.Scheme=="http"&&uri.Host is "127.0.0.1" or "[::1]"))throw new GatewayException("invalid_endpoint");
        Origin=origin;this.storage=storage;
        http=new HttpClient(transport??new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){Timeout=TimeSpan.FromSeconds(12)};
    }
    private void Validate(NativeLogin login) {
        if(!Matches(login.AuthorizationId,"na-[a-f0-9]{64}")||!Matches(login.UserCode,"[A-F0-9]{8}")||login.VerificationUri!=Origin+"/console/?native="+login.AuthorizationId||login.IntervalSeconds!=3||login.Status is not ("pending" or "approved" or "denied" or "cancelled"))throw new GatewayException("invalid_response");
        _=Date(login.ExpiresAt);
    }
    private void Validate(ControlMaterial material,bool requireFuture=false) {
        if(material.Version!=1||material.Origin!=Origin||material.Audience!="console"||!Matches(material.Session,"[a-f0-9]{64}")||!Matches(material.PrincipalId,"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}"))throw new GatewayException("invalid_response");
        var expiry=Date(material.ExpiresAt);
        if(requireFuture&&(expiry<=DateTimeOffset.UtcNow||expiry>DateTimeOffset.UtcNow.AddSeconds(3630)))throw new GatewayException("invalid_response");
    }
    private async Task<ControlState> Load(CancellationToken cancellation) {
        var saved=await storage.LoadAsync(StorageKey,cancellation);
        var state=saved is null?new ControlState(1,Origin):Decode<ControlState>(saved);
        if(state.Version!=1||state.Origin!=Origin)throw new GatewayException("invalid_response");
        if(state.Pending is {} pending) {
            if(pending.Proof is null||!Matches(pending.Proof.RequestKey,"[a-f0-9]{64}")||!Matches(pending.Proof.CodeVerifier,"[A-Za-z0-9._~-]{43,128}")||!Platform(pending.Platform))throw new GatewayException("invalid_response");
            if(pending.Login is {} login)Validate(login);
        }
        if(state.Material is {} material)Validate(material);
        var records=state.Operations??[];
        if(records.Count>128||records.Any(r=>r?.Reference?.Request is null||r.Reference.Origin!=Origin||!Matches(r.Id,"[a-f0-9]{64}"))||records.Select(r=>r.Id).Distinct().Count()!=records.Count)throw new GatewayException("invalid_response");
        return state;
    }
    private async Task Persist(ControlState next,CancellationToken cancellation) {
        cancellation.ThrowIfCancellationRequested();
        var encoded=JsonSerializer.Serialize(next,Json);
        await storage.SaveAsync(StorageKey,encoded,cancellation);
        // 宿主必须耐久保存并能回读；失败时不能发送授权或命令。
        if(await storage.LoadAsync(StorageKey,cancellation)!=encoded)throw new GatewayException("storage_verification_failed");
        cancellation.ThrowIfCancellationRequested();
    }
    private async Task<JsonObject> Request(string path,JsonObject? input=null,ControlMaterial? material=null,CancellationToken cancellation=default) {
        using var request=new HttpRequestMessage(input is null?HttpMethod.Get:HttpMethod.Post,Origin+path);
        request.Headers.Add("Cache-Control","no-store");
        if(input is not null)request.Content=new StringContent(input.ToJsonString(),Encoding.UTF8,"application/json");
        if(material is not null) {
            request.Headers.Add("Origin",Origin);
            request.Headers.Add("Cookie",(Origin.StartsWith("https:",StringComparison.Ordinal)?"__Host-limeiot_console=":"limeiot_console=")+material.Session);
            request.Headers.Add("X-CSRF-Token",Csrf(material));
        }
        using var response=await http.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancellation);
        if(response.RequestMessage?.RequestUri is {} final&&final.AbsoluteUri!=request.RequestUri!.AbsoluteUri)throw new GatewayException("invalid_response");
        if((int)response.StatusCode==401&&material is not null){var state=await Load(cancellation);await Persist(state with{Material=null},cancellation);throw new GatewayException("unauthenticated",401);}
        using var stream=await response.Content.ReadAsStreamAsync(cancellation);using var buffer=new MemoryStream();
        var chunk=new byte[8192];int count;
        while((count=await stream.ReadAsync(chunk,cancellation))>0){if(buffer.Length+count>262144)throw new GatewayException("invalid_response");buffer.Write(chunk,0,count);}
        JsonObject body;
        try{body=JsonNode.Parse(buffer.ToArray(),documentOptions:new JsonDocumentOptions{MaxDepth=32}) as JsonObject??throw new JsonException();}catch(JsonException){throw new GatewayException("invalid_response");}
        if((int)response.StatusCode!=200) {
            var code=body["error"]?["code"]?.ToString();
            throw new GatewayException(Matches(code,"[a-z0-9_]{1,80}")?code!:"request_failed",(int)response.StatusCode);
        }
        return body;
    }
    private static JsonObject Body<T>(T value)=>JsonSerializer.SerializeToNode(value,Json)!.AsObject();
    private async Task<ControlSession> Current(ControlMaterial material,CancellationToken cancellation) {
        Validate(material);
        var session=Decode<ControlSession>((await Request("/api/console/v1/auth/session",material:material,cancellation:cancellation)).ToJsonString());
        if(session.Audience!="console"||session.Principal?.PrincipalId!=material.PrincipalId||session.CsrfToken!=Csrf(material)||Date(session.ExpiresAt)<=DateTimeOffset.UtcNow||Math.Abs((Date(session.ExpiresAt)-Date(material.ExpiresAt)).TotalSeconds)>1)throw new GatewayException("invalid_response");
        return session;
    }
    private async Task<ControlMaterial> Authenticated(CancellationToken cancellation) {
        var material=(await Load(cancellation)).Material??throw new GatewayException("unauthenticated",401);
        _=await Current(material,cancellation);return material;
    }
    public Task<NativeLogin> BeginAuthorizationAsync(string platform="windows",CancellationToken cancellation=default)=>Locked(async()=>{
        var state=await Load(cancellation);
        if(state.Material is not null)throw new GatewayException("already_authenticated");
        if(!Platform(platform))throw new GatewayException("invalid_platform");
        if(state.Pending is null){state=state with{Pending=new NativePending(new NativeProof(RandomKey(),RandomKey()),platform)};await Persist(state,cancellation);}
        var pending=state.Pending!;
        if(pending.Platform!=platform)throw new GatewayException("invalid_platform");
        var challenge=Convert.ToBase64String(Hash(pending.Proof.CodeVerifier)).TrimEnd('=').Replace('+','-').Replace('/','_');
        var login=Decode<NativeLogin>((await Request("/api/native/v1/authorizations",new JsonObject{{"request_key",pending.Proof.RequestKey},{"code_challenge",challenge},{"platform",platform}},cancellation:cancellation)).ToJsonString());
        Validate(login);
        if(pending.Login is {} original&&(original.AuthorizationId!=login.AuthorizationId||original.UserCode!=login.UserCode||original.ExpiresAt!=login.ExpiresAt))throw new GatewayException("invalid_response");
        await Persist(state with{Pending=pending with{Login=login}},cancellation);return login;
    },cancellation);
    public Task<NativeLoginResult> PollAuthorizationAsync(CancellationToken cancellation=default)=>Locked(async()=>{
        var state=await Load(cancellation);var pending=state.Pending??throw new GatewayException("authorization_required");
        var body=await Request("/api/native/v1/authorizations/poll",Body(pending.Proof),cancellation:cancellation);
        var status=body["status"]?.ToString();var expires=body["expires_at"]?.ToString()??"";
        if(status is not ("pending" or "approved" or "denied" or "cancelled")||Date(expires)<=DateTimeOffset.UtcNow||pending.Login is {} login&&login.ExpiresAt!=expires)throw new GatewayException("invalid_response");
        if(status!="approved"){
            if(body["material"] is not null)throw new GatewayException("invalid_response");
            return new NativeLoginResult(status,null);
        }
        var material=Decode<ControlMaterial>(body["material"]?.ToJsonString()??"null");Validate(material,true);
        var session=await Current(material,cancellation);
        await Persist(state with{Material=material},cancellation);return new NativeLoginResult(status,session);
    },cancellation);
    public Task<bool> HasPendingAuthorizationAsync(CancellationToken cancellation=default)=>Locked(async()=>(await Load(cancellation)).Pending is not null,cancellation);
    public Task CancelAuthorizationAsync(CancellationToken cancellation=default)=>Locked(async()=>{
        var state=await Load(cancellation);var pending=state.Pending??throw new GatewayException("authorization_required");
        var body=await Request("/api/native/v1/authorizations/cancel",Body(pending.Proof),cancellation:cancellation);
        if(body["status"]?.ToString()!="cancelled")throw new GatewayException("invalid_response");
        await Persist(state with{Pending=null,Material=null},cancellation);return true;
    },cancellation);
    public Task<ControlSession> RestoreSessionAsync(CancellationToken cancellation=default)=>Locked(async()=>{
        var material=(await Load(cancellation)).Material??throw new GatewayException("unauthenticated",401);return await Current(material,cancellation);
    },cancellation);
    public Task LogoutAsync(CancellationToken cancellation=default)=>Locked(async()=>{
        var state=await Load(cancellation);var material=state.Material??throw new GatewayException("unauthenticated",401);
        var body=await Request("/api/console/v1/auth/logout",new(),material,cancellation);
        if(body["logged_out"]?.ToString()!="true")throw new GatewayException("invalid_response");
        await Persist(state with{Material=null,Pending=null},cancellation);return true;
    },cancellation);
    private Task<JsonObject> Read(string path,CancellationToken cancellation)=>Locked(async()=>await Request(path,material:await Authenticated(cancellation),cancellation:cancellation),cancellation);
    public async Task<IReadOnlyList<ControlSpace>> SpacesAsync(CancellationToken cancellation=default)=>Decode<ControlSpace[]>((await Read("/api/console/v1/spaces",cancellation))["spaces"]?.ToJsonString()??"null");
    public async Task<IReadOnlyList<ControlGateway>> GatewaysAsync(string space,CancellationToken cancellation=default)=>Decode<ControlGateway[]>((await Read("/api/console/v1/spaces/"+Segment(space)+"/gateways",cancellation))["gateways"]?.ToJsonString()??"null");
    public async Task<ControlDevicePage> DevicesAsync(string space,string? after=null,CancellationToken cancellation=default) {
        var body=await Read("/api/console/v1/spaces/"+Segment(space)+"/devices"+(after is null?"":"?after="+Segment(after)),cancellation);
        try{return new(body["items"]!.AsArray().Select(item=>new Device(item!["device_id"]!.GetValue<string>(),item["model_revision"]!.GetValue<string>(),item["ready"]!.GetValue<bool>())).ToArray(),body["next"]?.GetValue<string>(),body["binding_revision"]!.GetValue<string>());}
        catch(Exception error)when(error is not GatewayException){throw new GatewayException("invalid_response");}
    }
    public async Task<JsonObject> ModelAsync(string space,string revision,CancellationToken cancellation=default) {
        var body=await Read("/api/console/v1/spaces/"+Segment(space)+"/model-releases/"+Segment(revision),cancellation);
        if(body["revision"]?.ToString()!=revision||body["model"] is not JsonObject model)throw new GatewayException("invalid_response");return model;
    }
    public Task<ControlCommandRecord> PrepareCommandAsync(string space,ControlGateway gateway,Device device,string path,JsonNode? value,string type="property.set",CancellationToken cancellation=default)=>Locked(async()=>{
        var material=await Authenticated(cancellation);var state=await Load(cancellation);
        if(gateway.SpaceId!=space||gateway.PrincipalId!=material.PrincipalId||!gateway.Active||gateway.Scopes is null||!gateway.Scopes.Contains("commands.write"))throw new GatewayException("forbidden",403);
        if(!device.Ready)throw new GatewayException("device_offline",409);
        if(type is not ("property.set" or "action.invoke")||!Matches(path,"[a-z][a-z0-9_-]{0,63}\\.[a-z][a-z0-9_-]{0,63}"))throw new GatewayException("invalid_response");
        var records=(state.Operations??[]).ToList();if(records.Count>=128)throw new GatewayException("local_operation_capacity",429);
        var input=new ControlRemoteInput(RandomKey(),gateway.GatewayId,gateway.Revision,device.Id,device.ModelRevision,DateTimeOffset.UtcNow.AddSeconds(20).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'",CultureInfo.InvariantCulture),new JsonObject{{"type",type},{"path",path},{"value",value?.DeepClone()}});
        var record=new ControlCommandRecord(new(Origin,material.PrincipalId,space,gateway.LocalSpaceId,input));records.Add(record);
        await Persist(state with{Operations=records},cancellation);return record;
    },cancellation);
    private async Task<(ControlMaterial Material,ControlCommandRecord Record)> Context(string key,CancellationToken cancellation) {
        var material=await Authenticated(cancellation);
        var record=(await Load(cancellation)).Operations?.FirstOrDefault(r=>r.Id==key&&r.Reference.PrincipalId==material.PrincipalId&&r.Reference.Origin==Origin)??throw new GatewayException("operation_not_found",404);
        return(material,record);
    }
    private async Task SaveRecord(ControlCommandRecord record,CancellationToken cancellation) {
        var state=await Load(cancellation);var records=(state.Operations??[]).ToList();var index=records.FindIndex(r=>r.Id==record.Id&&Equal(r.Reference,record.Reference));
        if(index<0)throw new GatewayException("operation_not_found",404);
        records[index]=record;await Persist(state with{Operations=records},cancellation);
    }
    private static void Validate(ControlRemoteCommand result,ControlCommandRecord original) {
        var reference=original.Reference;var input=reference.Request;
        if(result.SpaceId!=reference.SpaceId||result.PrincipalId!=reference.PrincipalId||result.LocalSpaceId!=reference.LocalSpaceId||!Equal(result.Request,input)||!Matches(result.RemoteId,"remote-[a-f0-9]{64}")||!Matches(result.RequestDigest,"[a-f0-9]{64}")||result.Status is not ("unknown" or "accepted" or "dispatched" or "confirmed" or "failed" or "expired" or "rejected"))throw new GatewayException("invalid_response");
        if(original.Result is {} old&&(old.RemoteId!=result.RemoteId||old.RequestDigest!=result.RequestDigest||old.Terminal&&(old.Status!=result.Status||!Equal(old.LocalResult,result.LocalResult))))throw new GatewayException("invalid_response");
        if(result.Status!="confirmed")return;
        try {
            var receipt=result.LocalResult??throw new JsonException();var request=receipt["request"]!.AsObject();var evidence=receipt["evidence"]!.AsObject();
            if(receipt["status"]?.ToString()!="confirmed"||!receipt.ContainsKey("error")||receipt["error"] is not null||!Matches(receipt["command_id"]?.GetValue<string>(),"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")||!Matches(receipt["request_digest"]?.GetValue<string>(),"sha256:[a-f0-9]{64}")||request["space_id"]?.ToString()!=reference.LocalSpaceId||request["idempotency_key"]?.ToString()!=result.RemoteId||request["device_id"]?.ToString()!=input.DeviceId||request["model_revision"]?.ToString()!=input.ModelRevision||request["expires_at"]?.ToString()!=input.ExpiresAt||!JsonNode.DeepEquals(request["operation"],input.Operation))throw new JsonException();
            var path=input.Operation["path"]!.GetValue<string>();
            switch(input.Operation["type"]!.GetValue<string>()) {
                case "property.set":
                    if(evidence["type"]?.ToString()!="device_result"||evidence["reported"] is not JsonObject reported||!reported.ContainsKey(path)||!JsonNode.DeepEquals(reported[path],input.Operation["value"]))throw new JsonException();
                    break;
                case "action.invoke":
                    // RFC8785 摘要和精确模型由 Go/Rust 权威验证；此处绑定完整输入和证据外壳。
                    if(!evidence.Select(p=>p.Key).ToHashSet().SetEquals(["type","path","input_digest","output","completion","observed_at"])||evidence["type"]?.ToString()!="action_result"||evidence["path"]?.ToString()!=path||!Matches(evidence["input_digest"]?.GetValue<string>(),"sha256:[a-f0-9]{64}")||evidence["output"] is null||evidence["completion"]?.ToString() is not ("submitted" or "observed"))throw new JsonException();
                    var observed=Date(evidence["observed_at"]!.GetValue<string>());
                    if(observed<Date(input.ExpiresAt).AddSeconds(-32)||observed>DateTimeOffset.UtcNow.AddSeconds(2))throw new JsonException();
                    break;
                default:throw new JsonException();
            }
        }catch(Exception error)when(error is not GatewayException){throw new GatewayException("invalid_response");}
    }
    private async Task<ControlCommandRecord> ReadCommand(ControlMaterial material,ControlCommandRecord record,bool reconcile,CancellationToken cancellation) {
        var path="/api/console/v1/spaces/"+Segment(record.Reference.SpaceId)+"/remote-commands";
        var result=Decode<ControlRemoteCommand>((await Request(path+"/by-key/"+record.Id,material:material,cancellation:cancellation)).ToJsonString());Validate(result,record);
        record=record with{Attempted=true,Result=result};await SaveRecord(record,cancellation);
        if(reconcile&&!result.Terminal) {
            result=Decode<ControlRemoteCommand>((await Request(path+"/"+Segment(result.RemoteId)+"/reconcile",new(),material,cancellation)).ToJsonString());Validate(result,record);
            record=record with{Result=result};await SaveRecord(record,cancellation);
        }
        return record;
    }
    public Task<ControlCommandRecord> SubmitCommandAsync(string key,CancellationToken cancellation=default)=>Locked(async()=>{
        var (material,original)=await Context(key,cancellation);
        if(original.Rejection is not null)return original;
        if(original.Attempted)return await ReadCommand(material,original,false,cancellation);
        var record=original with{Attempted=true};await SaveRecord(record,cancellation);
        try {
            var path="/api/console/v1/spaces/"+Segment(record.Reference.SpaceId)+"/remote-commands";
            var result=Decode<ControlRemoteCommand>((await Request(path,Body(record.Reference.Request),material,cancellation)).ToJsonString());Validate(result,record);
            record=record with{Result=result};await SaveRecord(record,cancellation);return record;
        }catch(GatewayException error) {
            if(error.Status>=400&&error.Status<500&&error.Status is not (408 or 409)){record=record with{Rejection=error.Code};await SaveRecord(record,cancellation);}
            throw;
        }
    },cancellation);
    public Task<ControlCommandRecord> ResolveCommandAsync(string key,bool reconcile=false,CancellationToken cancellation=default)=>Locked(async()=>{
        var (material,record)=await Context(key,cancellation);
        return record.Rejection is not null?record:await ReadCommand(material,record,reconcile,cancellation);
    },cancellation);
    public Task<IReadOnlyList<ControlCommandRecord>> CommandRecordsAsync(string? space=null,CancellationToken cancellation=default)=>Locked<IReadOnlyList<ControlCommandRecord>>(async()=>{
        var material=await Authenticated(cancellation);
        return (await Load(cancellation)).Operations?.Where(r=>r.Reference.PrincipalId==material.PrincipalId&&(space is null||r.Reference.SpaceId==space)).ToArray()??[];
    },cancellation);
    public Task ForgetCommandAsync(string key,CancellationToken cancellation=default)=>Locked(async()=>{
        var (_,record)=await Context(key,cancellation);
        if(!record.CanForget)throw new GatewayException("operation_not_terminal",409);
        var state=await Load(cancellation);await Persist(state with{Operations=state.Operations!.Where(r=>r.Id!=key).ToArray()},cancellation);return true;
    },cancellation);
    public void Dispose(){http.Dispose();gate.Dispose();}
}
