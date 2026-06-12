#!/usr/bin/env python3
"""
ad4m-rpc.py — WebSocket RPC client for the AD4M executor (0.13.x WS API).

Usage:
    python3 ad4m-rpc.py [--host HOST] [--port PORT] [--token TOKEN] COMMAND [ARGS...]

Commands:
    wait-ready [--timeout SECS]
    agent-status
    agent-generate
    language-all
    language-get          ADDRESS
    language-publish      LANGUAGE_PATH NAME DESCRIPTION [POSSIBLE_TEMPLATE_PARAMS] [SOURCE_CODE_LINK]
    language-apply-template  SOURCE_HASH TEMPLATE_DATA_JSON
    perspective-all
    perspective-create    NAME
    perspective-remove    UUID
    perspective-add-link  UUID SOURCE TARGET PREDICATE
    perspective-remove-link UUID SOURCE TARGET PREDICATE
    perspective-query-links UUID [--source S] [--target T] [--predicate P]
    neighbourhood-publish UUID LINK_LANGUAGE_ADDRESS
    neighbourhood-join    URL
    raw                   TYPE PARAMS_JSON
"""
import argparse
import asyncio
import json
import sys
import uuid


def make_parser():
    p = argparse.ArgumentParser(description="AD4M WS-RPC CLI")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=12000)
    p.add_argument("--token", default="test123")
    sub = p.add_subparsers(dest="command")

    # wait-ready
    wr = sub.add_parser("wait-ready")
    wr.add_argument("--timeout", type=int, default=30)

    # agent
    sub.add_parser("agent-status")
    sub.add_parser("agent-generate")

    # language
    sub.add_parser("language-all")

    lg = sub.add_parser("language-get")
    lg.add_argument("address")

    lp = sub.add_parser("language-publish")
    lp.add_argument("language_path")
    lp.add_argument("name")
    lp.add_argument("description")
    lp.add_argument("--possible-template-params", default="[]")
    lp.add_argument("--source-code-link", default="")

    lat = sub.add_parser("language-apply-template")
    lat.add_argument("source_hash")
    lat.add_argument("template_data")  # JSON string

    # perspective
    sub.add_parser("perspective-all")

    pc = sub.add_parser("perspective-create")
    pc.add_argument("name")

    pr = sub.add_parser("perspective-remove")
    pr.add_argument("uuid")

    pal = sub.add_parser("perspective-add-link")
    pal.add_argument("uuid")
    pal.add_argument("source")
    pal.add_argument("target")
    pal.add_argument("predicate")

    prl = sub.add_parser("perspective-remove-link")
    prl.add_argument("uuid")
    prl.add_argument("source")
    prl.add_argument("target")
    prl.add_argument("predicate")

    pql = sub.add_parser("perspective-query-links")
    pql.add_argument("uuid")
    pql.add_argument("--source", default=None)
    pql.add_argument("--target", default=None)
    pql.add_argument("--predicate", default=None)

    # neighbourhood
    np = sub.add_parser("neighbourhood-publish")
    np.add_argument("perspective_uuid")
    np.add_argument("link_language")

    nj = sub.add_parser("neighbourhood-join")
    nj.add_argument("url")

    # expression
    eg = sub.add_parser("expression-get")
    eg.add_argument("address")

    ec = sub.add_parser("expression-create")
    ec.add_argument("language_address")
    ec.add_argument("content_json")

    eio = sub.add_parser("expression-is-immutable")
    eio.add_argument("address")

    # raw / generic
    rw = sub.add_parser("raw")
    rw.add_argument("rpc_type")
    rw.add_argument("params_json", nargs="?", default="{}")

    return p


async def rpc_call(host, port, token, rpc_type, params, timeout=10):
    """Open a WebSocket, send one RPC request, return the result or raise."""
    import websockets

    uri = f"ws://{host}:{port}/api/v1/ws?token={token}"
    req_id = str(uuid.uuid4())[:8]
    msg = json.dumps({"id": req_id, "type": rpc_type, "params": params})

    async with websockets.connect(uri, open_timeout=timeout, close_timeout=5) as ws:
        await ws.send(msg)
        # Read messages until we get one matching our request id
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"No response within {timeout}s")
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            resp = json.loads(raw)
            if resp.get("id") == req_id:
                if "error" in resp:
                    raise RuntimeError(json.dumps(resp["error"]))
                return resp.get("result")


async def wait_ready(host, port, token, timeout):
    """Poll agent.status until it responds or timeout."""
    import websockets

    for i in range(1, timeout + 1):
        try:
            result = await rpc_call(host, port, token, "agent.status", {}, timeout=5)
            return result
        except (ConnectionRefusedError, OSError, TimeoutError,
                websockets.exceptions.WebSocketException):
            pass
        except Exception:
            pass
        await asyncio.sleep(1)
    raise TimeoutError(f"Executor at {host}:{port} not ready after {timeout}s")


def build_rpc(args):
    """Return (rpc_type, params) for the given parsed args."""
    cmd = args.command

    if cmd == "agent-status":
        return "agent.status", {}
    if cmd == "agent-generate":
        return "agent.generate", {}
    if cmd == "language-all":
        return "language.all", {}
    if cmd == "language-get":
        return "language.get", {"address": args.address}
    if cmd == "language-publish":
        return "language.publish", {
            "languagePath": args.language_path,
            "languageMeta": {
                "name": args.name,
                "description": args.description,
                "possibleTemplateParams": json.loads(args.possible_template_params),
                "sourceCodeLink": args.source_code_link,
            },
        }
    if cmd == "language-apply-template":
        return "language.applyTemplate", {
            "sourceLanguageHash": args.source_hash,
            "templateData": args.template_data,
        }
    if cmd == "perspective-all":
        return "perspective.all", {}
    if cmd == "perspective-create":
        return "perspective.create", {"name": args.name}
    if cmd == "perspective-remove":
        return "perspective.remove", {"uuid": args.uuid}
    if cmd == "perspective-add-link":
        return "perspective.addLink", {
            "uuid": args.uuid,
            "link": {
                "source": args.source,
                "target": args.target,
                "predicate": args.predicate,
            },
        }
    if cmd == "perspective-remove-link":
        return "perspective.removeLink", {
            "uuid": args.uuid,
            "link": {
                "source": args.source,
                "target": args.target,
                "predicate": args.predicate,
            },
        }
    if cmd == "perspective-query-links":
        query = {}
        if args.source is not None:
            query["source"] = args.source
        if args.target is not None:
            query["target"] = args.target
        if args.predicate is not None:
            query["predicate"] = args.predicate
        return "perspective.queryLinks", {"uuid": args.uuid, "query": query}
    if cmd == "neighbourhood-publish":
        return "neighbourhood.publish", {
            "perspectiveUUID": args.perspective_uuid,
            "linkLanguage": args.link_language,
            "meta": {"links": []},
        }
    if cmd == "neighbourhood-join":
        return "neighbourhood.join", {"url": args.url}
    if cmd == "expression-get":
        return "expression.get", {"url": args.address}
    if cmd == "expression-create":
        return "expression.create", {
            "languageAddress": args.language_address,
            "content": json.loads(args.content_json),
        }
    if cmd == "expression-is-immutable":
        return "expression.isImmutableExpression", {"url": args.address}
    if cmd == "raw":
        return args.rpc_type, json.loads(args.params_json)

    raise ValueError(f"Unknown command: {cmd}")


async def main():
    parser = make_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        if args.command == "wait-ready":
            result = await wait_ready(args.host, args.port, args.token, args.timeout)
        else:
            rpc_type, params = build_rpc(args)
            result = await rpc_call(args.host, args.port, args.token, rpc_type, params)

        # Output JSON to stdout
        print(json.dumps(result, indent=None, ensure_ascii=False))
        sys.exit(0)

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
