import Foundation
import Security
import LimeIoTKit

// 仅测试使用独立CA锚点；保留证书期限和精确主机名校验，不修改系统信任。
private final class FixtureTrust: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let certificate: SecCertificate
    let host: String
    init(certificate: SecCertificate, host: String) { self.certificate = certificate; self.host = host }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == host, let trust = challenge.protectionSpace.serverTrust,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
struct ControlTLSTransport: HTTPTransport {
    let session: URLSession
    init(caFile: String, origin: String) throws {
        let pem = try String(contentsOfFile: caFile, encoding: .utf8).components(separatedBy: .newlines).filter { !$0.hasPrefix("-----") }.joined()
        guard let der = Data(base64Encoded: pem), let certificate = SecCertificateCreateWithData(nil, der as CFData),
              let host = URLComponents(string: origin)?.host else { throw ControlError.invalidResponse }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCache = nil; config.timeoutIntervalForRequest = 12
        session = URLSession(configuration: config, delegate: FixtureTrust(certificate: certificate, host: host), delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw ControlError.invalidResponse }
        return (data, response)
    }
}
