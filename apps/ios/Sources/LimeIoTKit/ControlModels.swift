import Foundation

public enum ControlError: Error, Equatable, Sendable {
    case invalidEndpoint, invalidResponse, unauthenticated, busy, authorizationRequired, alreadyAuthenticated
    case server(String, Int)
    public var message: String {
        switch self {
        case .invalidEndpoint: "请输入控制面的精确 HTTPS 地址"
        case .invalidResponse: "服务返回了无法识别的数据"
        case .unauthenticated: "会话已失效，请重新登录"
        case .busy: "正在处理上一项请求"
        case .authorizationRequired: "请先发起手机登录"
        case .alreadyAuthenticated: "请先退出当前账号"
        case .server(let code, _): [
            "native_authorization_expired": "登录请求已过期，请取消后重新发起",
            "identity_unavailable": "账号服务暂时不可用，请稍后重试",
            "rate_limited": "请求过于频繁，请稍后重试",
            "gateway_offline": "网关未连接，暂时无法远程操作",
            "identity_rejected": "凭据无效或会话已失效",
            "not_found": "未找到当前账号可访问的记录",
            "forbidden": "当前账号没有此权限",
            "local_operation_capacity": "本机操作记录已满，请清理已结束的记录",
            "operation_not_found": "未找到本机保存的原操作",
            "operation_not_terminal": "操作结果仍未确定，请先查询原操作"
        ][code] ?? "请求未完成（\(code)）"
        }
    }
}

public enum NativeAuthorizationStatus: String, Codable, Sendable { case pending, approved, denied, cancelled }
public struct NativeLogin: Codable, Sendable, CustomStringConvertible {
    public let authorizationId: String
    public let userCode: String
    public let verificationUri: String
    public let expiresAt: String
    public let intervalSeconds: Int
    public let status: NativeAuthorizationStatus
    public var description: String { "NativeLogin(status: \(status.rawValue), secrets: redacted)" }
}
public struct ControlPrincipal: Codable, Sendable { public let principalId: String; public let name: String }
public struct ControlSession: Codable, Sendable {
    public let audience: String
    public let principal: ControlPrincipal
    public let csrfToken: String
    public let expiresAt: String
}
public struct NativeLoginResult: Sendable { public let status: NativeAuthorizationStatus; public let session: ControlSession? }
public struct ControlSpace: Decodable, Sendable, Identifiable {
    public let spaceId: String; public let name: String; public var id: String { spaceId }
}
public struct ControlGateway: Decodable, Sendable, Identifiable {
    public let gatewayId: String
    public let spaceId: String
    public let localSpaceId: String
    public let principalId: String
    public let scopes: [String]
    public let revision: String
    public let active: Bool
    public var id: String { gatewayId }
}
public struct ControlDevicePage: Decodable, Sendable {
    public let items: [Device]
    public let next: String?
    public let bindingRevision: String
}
public enum ControlCommandStatus: String, Codable, Sendable {
    case unknown, accepted, dispatched, confirmed, failed, expired, rejected
    public var terminal: Bool { [.confirmed, .failed, .expired, .rejected].contains(self) }
}
public struct ControlRemoteInput: Codable, Sendable, Equatable {
    public let requestKey: String; public let gatewayId: String; public let bindingRevision: String
    public let deviceId: String; public let modelRevision: String; public let expiresAt: String; public let operation: Operation
}
public struct ControlCommandReference: Codable, Sendable, Equatable {
    public let origin: String; public let principalId: String; public let spaceId: String; public let localSpaceId: String
    public let request: ControlRemoteInput
}
public struct ControlRemoteCommand: Codable, Sendable {
    public let remoteId: String; public let spaceId: String; public let principalId: String; public let localSpaceId: String
    public let requestDigest: String; public let request: ControlRemoteInput
    public let status: ControlCommandStatus; public let localResult: JSONValue?
}
public struct ControlCommandRecord: Codable, Sendable, Identifiable {
    public let reference: ControlCommandReference
    public var attempted: Bool
    public var result: ControlRemoteCommand?
    public var rejection: String?
    public var id: String { reference.request.requestKey }
}

// 原生证明和会话材料只在客户端库与安全存储间流转。
struct NativeProof: Codable, Sendable { let requestKey: String; let codeVerifier: String }
struct NativePending: Codable, Sendable {
    let proof: NativeProof; let platform: String; var login: NativeLogin?
}
struct ControlMaterial: Codable, Sendable {
    let version: Int; let origin: String; let audience: String
    let session: String; let principalId: String; let expiresAt: String
}
struct ControlState: Codable, Sendable {
    let version: Int; let origin: String; var pending: NativePending?; var material: ControlMaterial?
    var operations: [ControlCommandRecord]?
}
