using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace LimeIoT.Client;

public sealed record NativeLogin(string AuthorizationId,string UserCode,string VerificationUri,string ExpiresAt,int IntervalSeconds,string Status) {
    public override string ToString()=>$"NativeLogin(status: {Status}, secrets: redacted)";
}
public sealed record ControlPrincipal(string PrincipalId,string Name);
public sealed record ControlSession(string Audience,ControlPrincipal Principal,string CsrfToken,string ExpiresAt) {
    public override string ToString()=>"ControlSession(secrets: redacted)";
}
public sealed record NativeLoginResult(string Status,ControlSession? Session);
public sealed record ControlSpace(string SpaceId,string Name);
public sealed record ControlGateway(string GatewayId,string SpaceId,string LocalSpaceId,string PrincipalId,IReadOnlyList<string> Scopes,string Revision,bool Active);
public sealed record ControlDevicePage(IReadOnlyList<Device> Items,string? Next,string BindingRevision);
public sealed record ControlRemoteInput(string RequestKey,string GatewayId,string BindingRevision,string DeviceId,string ModelRevision,string ExpiresAt,JsonObject Operation);
public sealed record ControlCommandReference(string Origin,string PrincipalId,string SpaceId,string LocalSpaceId,ControlRemoteInput Request);
public sealed record ControlRemoteCommand(string RemoteId,string SpaceId,string PrincipalId,string LocalSpaceId,string RequestDigest,ControlRemoteInput Request,string Status,JsonObject? LocalResult) {
    [JsonIgnore] public bool Terminal=>Status is "confirmed" or "failed" or "expired" or "rejected";
}
public sealed record ControlCommandRecord(ControlCommandReference Reference,bool Attempted=false,ControlRemoteCommand? Result=null,string? Rejection=null) {
    [JsonIgnore] public string Id=>Reference.Request.RequestKey;
    [JsonIgnore] public bool IsPrepared=>!Attempted&&Result is null&&Rejection is null;
    [JsonIgnore] public bool CanForget=>IsPrepared||Rejection is not null||Result?.Terminal==true;
}

// 证明与会话材料只在客户端和宿主安全存储之间流转。
internal sealed record NativeProof(string RequestKey,string CodeVerifier) { public override string ToString()=>"NativeProof(redacted)"; }
internal sealed record NativePending(NativeProof Proof,string Platform,NativeLogin? Login=null);
internal sealed record ControlMaterial(int Version,string Origin,string Audience,string Session,string PrincipalId,string ExpiresAt) { public override string ToString()=>"ControlMaterial(redacted)"; }
internal sealed record ControlState(int Version,string Origin,NativePending? Pending=null,ControlMaterial? Material=null,IReadOnlyList<ControlCommandRecord>? Operations=null);
