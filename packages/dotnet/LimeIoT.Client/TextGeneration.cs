using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LimeIoT.Client;

public sealed record TextGenerationRecord(JsonObject Original,JsonObject? Observation,string? RejectedCode) {
    public string Key=>Original["idempotency_key"]!.GetValue<string>();
    public string Space=>Original["space_id"]!.GetValue<string>();
    public string Status=>Observation?["status"]?.GetValue<string>()??(RejectedCode is null?"unresolved":"rejected");
    public bool Pending=>Status is "unresolved" or "running" or "unknown";
    [System.Text.Json.Serialization.JsonIgnore] public string? Text {get;init;}
}

// 仅用于本合同的整数 JSON。拒绝浮点数和无效 UTF-16，不将它作为通用 JCS API。
internal static class TextJson {
    public static void Require(bool condition){if(!condition)throw new GatewayException("invalid_text_response");}
    public static string String(JsonNode? node)=>node?.GetValue<string>()??throw new GatewayException("invalid_text_response");
    public static void Fields(JsonObject value,string names)=>Require(value.Select(p=>p.Key).Order(StringComparer.Ordinal).SequenceEqual(names.Split(',').Order(StringComparer.Ordinal)));
    public static string Quote(string value){
        var result=new StringBuilder("\"");
        for(var i=0;i<value.Length;i++){
            var c=value[i];if(char.IsHighSurrogate(c)){Require(i+1<value.Length&&char.IsLowSurrogate(value[i+1]));result.Append(c).Append(value[++i]);continue;}Require(!char.IsLowSurrogate(c));
            result.Append(c switch{'"'=>"\\\"",'\\'=>"\\\\",'\b'=>"\\b",'\f'=>"\\f",'\n'=>"\\n",'\r'=>"\\r",'\t'=>"\\t",< ' '=>"\\u"+((int)c).ToString("x4",CultureInfo.InvariantCulture),_=>c.ToString()});
        }
        return result.Append('"').ToString();
    }
    public static string Canonical(JsonNode? node)=>node switch{
        null=>"null",JsonObject value=>"{"+string.Join(',',value.OrderBy(p=>p.Key,StringComparer.Ordinal).Select(p=>Quote(p.Key)+":"+Canonical(p.Value)))+"}",
        JsonArray value=>"["+string.Join(',',value.Select(Canonical))+"]",
        JsonValue value when value.TryGetValue<string>(out var text)=>Quote(text),
        JsonValue value when value.TryGetValue<bool>(out var flag)=>flag?"true":"false",
        JsonValue value when value.TryGetValue<long>(out var integer)=>integer.ToString(CultureInfo.InvariantCulture),
        JsonValue value when value.TryGetValue<int>(out var integer)=>integer.ToString(CultureInfo.InvariantCulture),
        _=>throw new GatewayException("invalid_text_response")
    };
    public static string Digest(string text)=>"sha256:"+Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    public static void Hash(JsonNode? node)=>Require(Regex.IsMatch(String(node),"^sha256:[a-f0-9]{64}$"));
    public static void Id(string text)=>Require(Regex.IsMatch(text,"^[A-Za-z0-9_-]{1,128}$"));
    public static void Text(string text,int maximum,bool empty=false){Quote(text);Require((empty||!string.IsNullOrWhiteSpace(text.Trim('\uFEFF')))&&text.EnumerateRunes().Count()<=maximum&&Encoding.UTF8.GetByteCount(text)<=8192&&text.EnumerateRunes().All(c=>(c.Value>=32||c.Value is 9 or 10)&&!(c.Value>=127&&c.Value<=159)));}
    public static DateTimeOffset Time(JsonNode? node){var text=String(node);Require(Regex.IsMatch(text,@"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$"));return DateTimeOffset.Parse(text,CultureInfo.InvariantCulture);}
    public static void Deployment(JsonObject value){Fields(value,"adapter,revision,model,data_location");Require(String(value["adapter"])=="ollama-text-v1"&&String(value["data_location"])=="local");Hash(value["revision"]);Require(Regex.IsMatch(String(value["model"]),"^[A-Za-z0-9_:./-]{1,128}$"));}
    public static JsonObject Summary(JsonObject input){
        Fields(input,"instructions,messages,retain_seconds,expires_at");var instructions=String(input["instructions"]);Text(instructions,1024,true);
        var messages=input["messages"]!.AsArray();Require(messages.Count is >=1 and <=15&&messages.Count%2==1);var bytes=Encoding.UTF8.GetByteCount(instructions);
        for(var i=0;i<messages.Count;i++){var message=messages[i]!.AsObject();Fields(message,"role,content");Require(String(message["role"])==(i%2==0?"user":"assistant"));var text=String(message["content"]);Text(text,2048);bytes+=Encoding.UTF8.GetByteCount(text);}
        var retain=input["retain_seconds"]!.GetValue<int>();Require(bytes<=8192&&retain is >=60 and <=3600);Time(input["expires_at"]);
        return new(){{"context_digest",Digest(Canonical(new JsonObject{{"instructions",instructions},{"messages",messages.DeepClone()}}))},{"context_bytes",bytes},{"message_count",messages.Count},{"retain_seconds",retain},{"expires_at",input["expires_at"]!.DeepClone()}};
    }
    public static JsonObject Original(string origin,string space,string key,JsonObject summary){
        Id(space);Id(key);var request=new JsonObject{{"space_id",space},{"idempotency_key",key},{"input",summary.DeepClone()}};
        return new(){{"version",1},{"origin",origin},{"space_id",space},{"idempotency_key",key},{"input",summary.DeepClone()},{"request_digest",Digest(Canonical(request))}};
    }
    public static TextGenerationRecord Accept(JsonObject value,TextGenerationRecord original){
        Fields(value,"text_id,space_id,idempotency_key,request_digest,input,deployment,created_at,updated_at,status,output,usage,error_code");
        foreach(var key in new[]{"space_id","idempotency_key","request_digest","input"})Require(JsonNode.DeepEquals(value[key],original.Original[key]));
        var id=String(value["text_id"]);Id(id);Require(id.StartsWith("text-",StringComparison.Ordinal)&&id.Length>5);Deployment(value["deployment"]!.AsObject());
        var start=Time(value["created_at"]);var updated=Time(value["updated_at"]);var end=Time(original.Original["input"]!["expires_at"]);Require(end>start&&(end-start).TotalSeconds<=90&&updated>=start);
        var status=String(value["status"]);string? text=null;
        if(value["usage"] is JsonObject usage){Fields(usage,"input_tokens,output_tokens");Require(status=="succeeded"&&usage["input_tokens"]!.GetValue<int>() is >=0 and <=65536&&usage["output_tokens"]!.GetValue<int>() is >=1 and <=1024);}
        switch(status){
            case "running":Require(value["output"] is null&&value["error_code"] is null&&start==updated);break;
            case "succeeded":
                var output=value["output"]!.AsObject();Fields(output,"text,content_digest,expires_at,cleared_at");Hash(output["content_digest"]);Require((Time(output["expires_at"])-updated).TotalSeconds==original.Original["input"]!["retain_seconds"]!.GetValue<int>()&&value["error_code"] is null&&updated<end);
                if(output["cleared_at"] is null){text=String(output["text"]);Text(text,2048);Require(String(output["content_digest"])==Digest(text));if(Time(output["expires_at"])<=DateTimeOffset.UtcNow)text=null;}
                else Require(output["text"] is null&&Time(output["cleared_at"])>=updated);break;
            case "discarded":Require(value["output"] is null&&String(value["error_code"])=="text_output_discarded");break;
            case "unknown":Require(value["output"] is null&&new[]{"text_provider_unknown","text_deadline_exceeded","text_interrupted"}.Contains(String(value["error_code"])));break;
            case "failed":Require(value["output"] is null&&new[]{"text_provider_rejected","invalid_text_output","text_output_too_large","text_origin_not_local","text_provider_unavailable"}.Contains(String(value["error_code"])));break;
            default:throw new GatewayException("invalid_text_response");
        }
        var metadata=(JsonObject)value.DeepClone();if(metadata["output"] is JsonObject saved)saved.Remove("text");
        if(original.Observation is JsonObject previous){
            foreach(var key in new[]{"text_id","space_id","idempotency_key","request_digest","input","deployment","created_at"})Require(JsonNode.DeepEquals(previous[key],metadata[key]));
            Require(updated>=Time(previous["updated_at"]));var old=String(previous["status"]);
            if(old is "failed" or "discarded")Require(JsonNode.DeepEquals(previous,metadata));
            if(old=="unknown")Require(status is "unknown" or "discarded");
            if(old=="succeeded"){
                var before=(JsonObject)previous.DeepClone();var after=(JsonObject)metadata.DeepClone();before["output"]!.AsObject().Remove("cleared_at");after["output"]!.AsObject().Remove("cleared_at");Require(JsonNode.DeepEquals(before,after));
                if(previous["output"]!["cleared_at"] is not null)Require(JsonNode.DeepEquals(previous,metadata));
            }
        }
        return original with{Observation=metadata,Text=text};
    }
}

/// <summary>有界文字任务。提交前持久化摘要，丢失响应后仅查询原键；正文不写入记录。</summary>
public sealed class TextGenerationClient(GatewayClient gateway,ISessionStore storage) {
    private static readonly ConcurrentDictionary<string,SemaphoreSlim> Gates=new();
    private SemaphoreSlim Gate=>Gates.GetOrAdd(gateway.Origin,_=>new(1,1));
    private string Scope=>gateway.Origin+"#text-generations-dotnet";
    public static JsonObject Input(string text,string instructions="",int retainSeconds=600){var input=new JsonObject{{"instructions",instructions},{"messages",new JsonArray(new JsonObject{{"role","user"},{"content",text}})},{"retain_seconds",retainSeconds},{"expires_at",DateTimeOffset.UtcNow.AddSeconds(85).ToString("yyyy-MM-ddTHH:mm:ss.fffZ",CultureInfo.InvariantCulture)}};TextJson.Summary(input);return input;}
    public async Task<bool> ConfiguredAsync(string space,CancellationToken cancellation=default){var result=await gateway.CallAsync(GatewayClient.SpacePath(space)+"/capabilities",cancellation:cancellation);var text=result["text"]!.AsObject();TextJson.Require(TextJson.String(text["capability"])=="text.generate");var configured=text["configured"]!.GetValue<bool>();if(configured)TextJson.Deployment(text["deployment"]!.AsObject());return configured;}
    private async Task<List<TextGenerationRecord>> Load(CancellationToken cancellation){
        var data=await storage.LoadAsync(Scope,cancellation);if(data is null)return [];
        try{var rows=JsonSerializer.Deserialize<List<TextGenerationRecord>>(data)??throw new JsonException();TextJson.Require(rows.Count<=128&&rows.Select(r=>r.Space+":"+r.Key).Distinct().Count()==rows.Count);foreach(var row in rows)TextJson.Require(JsonNode.DeepEquals(row.Original,TextJson.Original(gateway.Origin,row.Space,row.Key,row.Original["input"]!.AsObject())));return rows;}
        catch{throw new GatewayException("text_storage_failed");}
    }
    private async Task Persist(List<TextGenerationRecord> records,CancellationToken cancellation){var data=JsonSerializer.Serialize(records);await storage.SaveAsync(Scope,data,cancellation);if(await storage.LoadAsync(Scope,cancellation)!=data)throw new GatewayException("text_storage_failed");}
    public async Task<IReadOnlyList<TextGenerationRecord>> RecordsAsync(string space,CancellationToken cancellation=default){TextJson.Id(space);await Gate.WaitAsync(cancellation);try{return(await Load(cancellation)).Where(r=>r.Space==space).ToArray();}finally{Gate.Release();}}
    private async Task<TextGenerationRecord> Accept(JsonObject value,TextGenerationRecord record,List<TextGenerationRecord> rows,CancellationToken cancellation){var next=TextJson.Accept(value,record);rows[rows.FindIndex(r=>r.Space==record.Space&&r.Key==record.Key)]=next;await Persist(rows,cancellation);return next;}
    public async Task<TextGenerationRecord> SubmitAsync(string space,JsonObject input,CancellationToken cancellation=default){
        await Gate.WaitAsync(cancellation);try{
            var rows=await Load(cancellation);if(rows.Any(r=>r.Space==space&&r.Pending))throw new GatewayException("text_pending");if(rows.Count>=128)throw new GatewayException("text_capacity");
            var key=Guid.NewGuid().ToString();var record=new TextGenerationRecord(TextJson.Original(gateway.Origin,space,key,TextJson.Summary(input)),null,null);rows.Add(record);await Persist(rows,cancellation);
            JsonObject result;try{result=await gateway.CallAsync(GatewayClient.SpacePath(space)+"/text-generations",HttpMethod.Post,input,key,cancellation);}
            catch(GatewayException error)when(error.Status is 400 or 401 or 403 or 404 or 409 or 422 or 429){rows[^1]=record with{RejectedCode=error.Code};await Persist(rows,cancellation);throw;}
            return await Accept(result,record,rows,cancellation);
        }finally{Gate.Release();}
    }
    public async Task<TextGenerationRecord> ResolveAsync(string space,string key,CancellationToken cancellation=default){
        TextJson.Id(space);TextJson.Id(key);await Gate.WaitAsync(cancellation);try{var rows=await Load(cancellation);var record=rows.SingleOrDefault(r=>r.Space==space&&r.Key==key)??throw new GatewayException("text_record_missing");return await Accept(await gateway.CallAsync(GatewayClient.SpacePath(space)+"/text-generations/by-key/"+key,cancellation:cancellation),record,rows,cancellation);}finally{Gate.Release();}
    }
}
