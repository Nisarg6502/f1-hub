"""Unit tests for `agent/checkpointer.py` — the degrade-soft paths.

A real round trip against Atlas is `agent/spikes/checkpointer_spike.py`'s job
(already measured — see `agent/spikes/README.md` §3) and is deliberately not
repeated here: these tests only prove that an absent or broken
`MONGODB_URI` degrades to "no thread memory" rather than crashing the
service, which is the behaviour `main.py`'s lifespan hook actually depends
on for every local run and every test that does not set the env var.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import checkpointer


class OpenSaverTests(unittest.TestCase):
    def tearDown(self):
        checkpointer.close_saver()

    def test_no_uri_degrades_to_none(self):
        with patch.object(checkpointer.config, "mongodb_uri", lambda: None):
            self.assertIsNone(checkpointer.open_saver())
        self.assertIsNone(checkpointer.current())

    def test_broken_connection_degrades_to_none_rather_than_raising(self):
        """A URI that fails to open must not crash the service.

        `MongoDBSaver.from_conn_string` opening against an unreachable host
        waits out pymongo's real connection timeout (tens of seconds) before
        raising, which is correct production behaviour and a bad unit test —
        so the failure is injected directly rather than waited for.
        """
        from langgraph.checkpoint.mongodb import MongoDBSaver

        def _boom(*_a, **_k):
            raise OSError("getaddrinfo failed")

        with patch.object(checkpointer.config, "mongodb_uri", lambda: "mongodb://bad-host/"), \
                patch.object(MongoDBSaver, "from_conn_string", _boom):
            self.assertIsNone(checkpointer.open_saver())

    def test_close_saver_is_a_no_op_when_nothing_was_opened(self):
        checkpointer.close_saver()  # must not raise
        self.assertIsNone(checkpointer.current())


if __name__ == "__main__":
    unittest.main()
