import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer

import razer_helper

CASES = [
    ("curl on localhost", "GET", "/index.html", {"Host": "localhost:{port}"}, 200),
    ("curl on 127.0.0.1", "GET", "/index.html", {"Host": "127.0.0.1:{port}"}, 200),
    ("curl on [::1]", "GET", "/index.html", {"Host": "[::1]:{port}"}, 200),
    ("own page", "GET", "/index.html",
     {"Host": "localhost:{port}", "Origin": "http://localhost:{port}", "Sec-Fetch-Site": "same-origin"}, 200),
    ("own page POST of an unknown preset fails before any HID I/O", "POST", "/api/headset/preset?id=999",
     {"Host": "localhost:{port}", "Origin": "http://localhost:{port}", "Sec-Fetch-Site": "same-origin"}, 500),
    ("address bar", "GET", "/index.html", {"Host": "localhost:{port}", "Sec-Fetch-Site": "none"}, 200),
    ("DNS rebinding", "GET", "/index.html", {"Host": "evil.example:{port}"}, 403),
    ("rebinding to localhost.*", "GET", "/index.html", {"Host": "localhost.evil.example:{port}"}, 403),
    ("cross-site fetch", "GET", "/index.html",
     {"Host": "localhost:{port}", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, 403),
    ("cross-site GET without Origin", "GET", "/index.html",
     {"Host": "localhost:{port}", "Sec-Fetch-Site": "cross-site"}, 403),
    ("other localhost port", "GET", "/index.html",
     {"Host": "localhost:{port}", "Origin": "http://localhost:3000", "Sec-Fetch-Site": "same-site"}, 403),
    ("opaque origin", "GET", "/index.html", {"Host": "localhost:{port}", "Origin": "null"}, 403),
    ("Origin on another local name", "GET", "/index.html",
     {"Host": "127.0.0.1:{port}", "Origin": "http://localhost:{port}"}, 403),
    ("cross-site POST", "POST", "/api/headset/preset?id=7",
     {"Host": "localhost:{port}", "Origin": "https://evil.example", "Sec-Fetch-Site": "cross-site"}, 403),
]


class RequestGuardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), razer_helper.Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_cases(self):
        for name, method, path, headers, expected in CASES:
            with self.subTest(name):
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
                conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                for k, v in headers.items():
                    conn.putheader(k, v.format(port=self.port))
                conn.endheaders()
                status = conn.getresponse().status
                conn.close()
                self.assertEqual(status, expected)


if __name__ == "__main__":
    unittest.main()
