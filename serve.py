#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""瀚海归义录 本地无缓存静态服务器

为所有响应加 no-store/no-cache 头，避免浏览器缓存旧 CSS/JS，
改完代码后普通刷新（F5）即可生效，无需强制刷新。

用法：python serve.py [端口]
"""
import sys
import http.server
import socketserver

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8086
BIND = "127.0.0.1"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ReusableServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with ReusableServer((BIND, PORT), NoCacheHandler) as httpd:
        print("瀚海归义录 本地服务已启动：http://%s:%d/start-screen-noST.html" % (BIND, PORT))
        print("已禁用浏览器缓存，改完代码直接刷新即可生效。按 Ctrl+C 停止。")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")
