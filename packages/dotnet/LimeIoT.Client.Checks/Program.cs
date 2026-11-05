using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using LimeIoT.Client;

static void Check(bool condition,string detail){if(!condition)throw new InvalidOperationException(detail);}
foreach(var origin in new[]{"http://nas.local","https://user@nas.local","https://nas.local/","https://nas.local/path","https://nas.local?token=x"}){
    try{using var invalid=new GatewayClient(origin,new MemoryStore());throw new Exception("invalid origin accepted");}catch(GatewayException error)when(error.Code=="invalid_endpoint"){}
}
var store=new MemoryStore();var handler=new FixtureHandler();using var client=new GatewayClient("https://gateway.example",store,handler);
await client.LoginAsync("fixture-owner-input");Check((await client.SpacesAsync()).SequenceEqual(new[]{"first","chosen"}),"spaces");
var snapshot=await client.SnapshotAsync("chosen");Check(snapshot.Space=="chosen"&&snapshot.Devices.Count==1,"explicit space");Check(handler.Paths.Where(p=>p.Contains("/spaces/")).All(p=>p.Contains("/spaces/chosen/")),"no fallback");
var original=CommandIntent.Create(snapshot.Devices[0],"link.exchange",new JsonObject{{"text","你好"}});
try{await client.CreateAsync("chosen",original);throw new Exception("timeout expected");}catch(HttpRequestException){}
try{await client.ResolveAsync("chosen",original);throw new Exception("404 expected");}catch(GatewayException error)when(error.Status==404){}
Check(handler.CommandPosts==1&&handler.ResolveQueries==1,"query only");Check(handler.OwnerCredentialRequests==1&&handler.Bearers==0,"credential isolation");
var request=original.Input;request["space_id"]="chosen";request["idempotency_key"]=original.Key;
var receipt=new JsonObject{{"command_id","command-1"},{"status","confirmed"},{"error",null},{"request_digest","sha256:"+new string('a',64)},{"request",request},{"evidence",new JsonObject{{"type","action_result"},{"path","link.exchange"},{"input_digest","sha256:"+new string('b',64)},{"output",new JsonObject()},{"completion","submitted"},{"observed_at",DateTimeOffset.UtcNow.ToString("O")}}}};
Check(GatewayClient.Validate(receipt,"chosen",original).Id=="command-1","valid receipt");
receipt["request"]!["device_id"]="wrong-target";
try{GatewayClient.Validate(receipt,"chosen",original);throw new Exception("mismatched receipt accepted");}catch(GatewayException error)when(error.Code=="invalid_response"){}
await TextChecks.Run();
Console.WriteLine("{\"passed\":true,\"groups\":10,\"exact_origin\":true,\"explicit_space\":true,\"cookie_credentials\":true,\"no_automatic_command_retry\":true,\"original_receipt_binding\":true}");

sealed class MemoryStore:ISessionStore {
    private readonly Dictionary<string,string> values=new();
    public Task<string?> LoadAsync(string scope,CancellationToken cancellation=default)=>Task.FromResult(values.GetValueOrDefault(scope));
    public Task SaveAsync(string scope,string? value,CancellationToken cancellation=default){if(value is null)values.Remove(scope);else values[scope]=value;return Task.CompletedTask;}
}
sealed class FixtureHandler:HttpMessageHandler {
    public List<string> Paths {get;}=[];public int CommandPosts;public int ResolveQueries;public int OwnerCredentialRequests;public int Bearers;
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
        var path=request.RequestUri!.AbsolutePath;Paths.Add(path);if(request.Headers.Authorization is not null)Bearers++;
        var status=HttpStatusCode.OK;string body;
        if(path=="/api/v1/auth/session"){
            if(request.Method==HttpMethod.Post){OwnerCredentialRequests++;var input=await request.Content!.ReadAsStringAsync(cancellation);if(!input.Contains("fixture-owner-input"))throw new Exception("missing login input");}
            body="{\"authenticated\":true,\"csrf_token\":\"csrf\",\"expires_at\":\"2030-01-01T00:00:00Z\"}";
        }else if(path=="/api/v1/spaces")body="{\"items\":[{\"space_id\":\"first\"},{\"space_id\":\"chosen\"}],\"next_cursor\":null}";
        else if(path.EndsWith("/capabilities",StringComparison.Ordinal))body="{\"models\":{}}";
        else if(path.EndsWith("/devices",StringComparison.Ordinal))body="{\"items\":[{\"device_id\":\"desktop\",\"model_revision\":\"sha256:fixture\",\"ready\":true}]}";
        else if(path.EndsWith("/commands",StringComparison.Ordinal)&&request.Method==HttpMethod.Post){CommandPosts++;throw new HttpRequestException("response_lost");}
        else{ResolveQueries++;status=HttpStatusCode.NotFound;body="{\"error\":{\"code\":\"command_not_found\"}}";}
        var response=new HttpResponseMessage(status){Content=new StringContent(body,Encoding.UTF8,"application/json")};response.Headers.TryAddWithoutValidation("Set-Cookie","__Host-limeiot_session="+new string('a',64)+"; Secure; HttpOnly");return response;
    }
}
