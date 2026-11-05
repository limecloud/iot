using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using LimeIoT.Client;

static class LocalPropertyChecks {
    private static void Check(bool value,string message){if(!value)throw new InvalidOperationException(message);}
    public static async Task Run(){
        var handler=new Handler();using var gateway=new GatewayClient("https://gateway.example",new MemoryStore(),handler);
        await gateway.LoginAsync("fixture");var snapshot=await gateway.SnapshotAsync("chosen");var lamp=snapshot.Devices.Single();
        Check(lamp.Reported?["light.power"]?["value"]?.GetValue<bool>()==false&&lamp.Reported["light.power"]?["quality"]?.GetValue<string>()=="good","local observations preserved");
        var value=JsonValue.Create(true)!;var intent=CommandIntent.Create(lamp,"light.power",value,"property.set");
        var receipt=await gateway.CreateAsync("chosen",intent);Check(receipt.Status=="confirmed","property device evidence");
        var bad=(JsonObject)receipt.Document.DeepClone();bad["evidence"]!["reported"]!["light.power"]=false;Invalid(bad,intent,"wrong reported value");
        bad=(JsonObject)receipt.Document.DeepClone();bad["evidence"]!["reported"]!.AsObject().Remove("light.power");Invalid(bad,intent,"missing reported path");
        bad=(JsonObject)receipt.Document.DeepClone();bad["evidence"]!["type"]="action_result";Invalid(bad,intent,"wrong evidence kind");
        bad=(JsonObject)receipt.Document.DeepClone();bad["request"]!["operation"]!["path"]="light.brightness";Invalid(bad,intent,"wrong request path");
        bad=(JsonObject)receipt.Document.DeepClone();bad["error"]=new JsonObject{{"code","device_failed"}};Invalid(bad,intent,"confirmed with error");
        var unknown=(JsonObject)receipt.Document.DeepClone();unknown["status"]="unknown";unknown["evidence"]=null;
        Check(GatewayClient.Validate(unknown,"chosen",intent).Status=="unknown","unknown is not success");
        handler.Lose=true;
        try{await gateway.CreateAsync("chosen",intent);throw new Exception("lost response expected");}catch(HttpRequestException){}
        handler.Missing=true;
        try{await gateway.ResolveAsync("chosen",intent);throw new Exception("404 expected");}catch(GatewayException e)when(e.Status==404){}
        handler.Missing=false;Check((await gateway.ResolveAsync("chosen",intent)).Status=="confirmed"&&handler.Posts==2&&handler.Gets==2,"recovery only queries original property key");
        var action=CommandIntent.Create(lamp,"remote.press",new JsonObject{{"key","home"}});Check(action.Operation["type"]!.GetValue<string>()=="action.invoke","existing action default unchanged");
        try{CommandIntent.Create(lamp,"light.power",value,"shell.execute");throw new Exception("unknown type accepted");}catch(GatewayException e)when(e.Code=="invalid_operation"){}
        Console.WriteLine("{\"local_property_checks\":true,\"observations\":true,\"device_result_binding\":true,\"get_only_recovery\":true,\"hardware\":false}");
    }
    private static void Invalid(JsonObject value,CommandIntent intent,string message){try{GatewayClient.Validate(value,"chosen",intent);throw new Exception(message);}catch(GatewayException e)when(e.Code=="invalid_response"){} }
    private sealed class Handler:HttpMessageHandler {
        public int Posts,Gets;public bool Lose,Missing;private JsonObject? last;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
            var path=request.RequestUri!.AbsolutePath;JsonObject body;var status=HttpStatusCode.OK;
            if(path.EndsWith("/auth/session",StringComparison.Ordinal))body=new(){{"csrf_token","fixture"}};
            else if(path.EndsWith("/capabilities",StringComparison.Ordinal))body=new(){{"models",new JsonObject()}};
            else if(path.EndsWith("/devices",StringComparison.Ordinal))body=new(){{"items",new JsonArray(new JsonObject{{"device_id","lamp"},{"model_revision","sha256:"+new string('b',64)},{"ready",true},{"reported",new JsonObject{{"light.power",new JsonObject{{"value",false},{"observed_at",DateTimeOffset.UtcNow.ToString("O")},{"quality","good"},{"source","device"}}}}}})}};
            else if(request.Method==HttpMethod.Post){
                Posts++;var input=JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellation))!.AsObject();input["space_id"]="chosen";input["idempotency_key"]=request.Headers.GetValues("Idempotency-Key").Single();
                body=new(){{"command_id","property-1"},{"status","confirmed"},{"request_digest","sha256:"+new string('c',64)},{"request",input},{"error",null},{"evidence",new JsonObject{{"type","device_result"},{"reported",new JsonObject{{"light.power",input["operation"]!["value"]!.DeepClone()}}}}}};last=(JsonObject)body.DeepClone();
                if(Lose){Lose=false;throw new HttpRequestException("response_lost");}
            }else{Gets++;if(Missing){status=HttpStatusCode.NotFound;body=new(){{"error",new JsonObject{{"code","command_not_found"}}}};}else body=(JsonObject)last!.DeepClone();}
            var response=new HttpResponseMessage(status){Content=new StringContent(body.ToJsonString(),Encoding.UTF8,"application/json")};response.Headers.TryAddWithoutValidation("Set-Cookie","__Host-limeiot_session="+new string('a',64)+"; Secure; HttpOnly");return response;
        }
    }
}
