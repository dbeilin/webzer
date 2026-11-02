import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from unittest import mock

import razer_helper


class StopWhenIdleTest(unittest.TestCase):
    def test_a_request_postpones_the_stop(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), razer_helper.Handler)
        self.addCleanup(server.server_close)
        serving = threading.Thread(target=server.serve_forever, daemon=True)
        serving.start()

        with mock.patch.object(razer_helper, "IDLE_STOP_SECONDS", 0.4):
            razer_helper.last_request = time.monotonic()
            threading.Thread(target=razer_helper.stop_when_idle, args=(server,), daemon=True).start()

            time.sleep(0.25)
            razer_helper.last_request = time.monotonic()
            time.sleep(0.25)
            self.assertTrue(serving.is_alive(), "stopped despite a recent request")

            serving.join(timeout=2)
            self.assertFalse(serving.is_alive(), "still serving after going idle")


if __name__ == "__main__":
    unittest.main()
