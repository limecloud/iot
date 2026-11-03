package control

import "net/http"

type oidcTransport struct{}

func (oidcTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	// 标明服务端消费者，避免身份服务的边缘检查拒绝默认通用客户端标识。
	request = request.Clone(request.Context())
	request.Header.Set("User-Agent", "LimeIoT-Control/0.3.0 (+https://iot.limeai.run)")
	if request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "application/json")
	}
	return http.DefaultTransport.RoundTrip(request)
}
