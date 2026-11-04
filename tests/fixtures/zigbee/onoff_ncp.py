"""同一软件NCP的温湿度与On/Off端点，复用既有字节协议夹具。"""
from ncp import RuntimeProtocol, serve

serve(RuntimeProtocol(on_off=True))
