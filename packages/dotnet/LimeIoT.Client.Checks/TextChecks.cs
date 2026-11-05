using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using LimeIoT.Client;

static class TextChecks {
    public static async Task Run(){
        static void Check(bool value,string detail){if(!value)throw new Exception(detail);}
        var store=new TextStore();var handler=new TextHandler(store);using var gateway=new GatewayClient("https://gateway.example",store,handler);await gateway.LoginAsync("fixture");
        var client=new TextGenerationClient(gateway,store);var input=TextGenerationClient.Input("你好 👋","只生成草稿");
        try{await client.SubmitAsync("chosen",input);throw new Exception("timeout expected");}catch(HttpRequestException){}
        var records=await client.RecordsAsync("chosen");Check(records.Count==1&&records[0].Pending,"original persisted");
        Check(!store.Data.Contains("你好",StringComparison.Ordinal)&&!store.Data.Contains("只生成草稿",StringComparison.Ordinal),"body not stored");
        Check(records[0].Original["input"]!["context_digest"]!.GetValue<string>()=="sha256:e3a24d056a025d8ba1a83c57ab9a74ff6d1cf5486ac5bfd33b8b7f3234f9904f","independent unicode canonical vector");
        try{await client.SubmitAsync("chosen",input);throw new Exception("second submit accepted");}catch(GatewayException e)when(e.Code=="text_pending"){}
        var restored=new TextGenerationClient(gateway,store);var result=await restored.ResolveAsync("chosen",records[0].Key);
        Check(result.Text=="已整理草稿"&&result.Status=="succeeded"&&!store.Data.Contains("已整理草稿",StringComparison.Ordinal),"verified output only in memory");
        handler.Tamper=true;
        try{await restored.ResolveAsync("chosen",records[0].Key);throw new Exception("foreign receipt accepted");}catch(GatewayException e)when(e.Code=="invalid_text_response"){}
        Check(handler.Posts==1&&handler.Gets==2,"recovery only gets original");
        store.Fail=true;var before=handler.Posts;
        try{await restored.SubmitAsync("other",input);throw new Exception("save expected");}catch(IOException){}
        Check(handler.Posts==before,"failed durable write means zero post");
        Console.WriteLine("{\"text_checks\":5,\"passed\":true,\"model_quality\":false}");
    }
    private sealed class TextStore:ISessionStore {
        private readonly Dictionary<string,string> data=new();public bool Fail;
        public string Data=>string.Join('\n',data.Values);
        public Task<string?> LoadAsync(string scope,CancellationToken cancellation=default)=>Task.FromResult(data.GetValueOrDefault(scope));
        public Task SaveAsync(string scope,string? value,CancellationToken cancellation=default){if(Fail)throw new IOException("fixture save failure");if(value is null)data.Remove(scope);else data[scope]=value;return Task.CompletedTask;}
    }
    private sealed class TextHandler(TextStore store):HttpMessageHandler {
        public int Posts,Gets;public bool Tamper;private JsonObject? response;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellation){
            if(request.RequestUri!.AbsolutePath.EndsWith("/auth/session",StringComparison.Ordinal)){
                var auth=new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("{\"csrf_token\":\"csrf\",\"authenticated\":true}")};auth.Headers.TryAddWithoutValidation("Set-Cookie","__Host-limeiot_session="+new string('a',64)+"; Secure; HttpOnly");return auth;
            }
            if(request.Method==HttpMethod.Post){Posts++;throw new HttpRequestException("fixture response lost");}
            Gets++;
            if(response is null){
                var data=await store.LoadAsync("https://gateway.example#text-generations-dotnet",cancellation);var original=JsonSerializer.Deserialize<List<TextGenerationRecord>>(data!)![0].Original;
                var now=DateTimeOffset.UtcNow;var text="已整理草稿";
                response=new JsonObject{{"text_id","text-fixture"},{"space_id",original["space_id"]!.DeepClone()},{"idempotency_key",original["idempotency_key"]!.DeepClone()},{"request_digest",original["request_digest"]!.DeepClone()},{"input",original["input"]!.DeepClone()},{"deployment",new JsonObject{{"adapter","ollama-text-v1"},{"revision","sha256:"+new string('a',64)},{"model","fixture"},{"data_location","local"}}},{"created_at",now.AddSeconds(-1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")},{"updated_at",now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")},{"status","succeeded"},{"output",new JsonObject{{"text",text},{"content_digest","sha256:"+Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)))},{"expires_at",now.AddSeconds(600).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")},{"cleared_at",null}}},{"usage",null},{"error_code",null}};
            }
            var value=(JsonObject)response.DeepClone();if(Tamper)value["space_id"]="other";
            return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(value.ToJsonString(),Encoding.UTF8,"application/json")};
        }
    }
}
