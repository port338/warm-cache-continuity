#!/usr/bin/env python3
"""Dependency-free semantic search for remote agents. Calls the main host search proxy.

Usage:
  python3 session_search.py "query"           # search this agent's collection
  python3 session_search.py --main "query"    # search the main host's sessions
"""
import os, sys, json, urllib.request, urllib.parse

PROXY_URL = os.environ.get("SEARCH_PROXY_URL", "http://127.0.0.1:8010")

def search(query, collection="remote-sessions", n=5):
    url = PROXY_URL + "?q=" + urllib.parse.quote(query) + "&c=" + collection + "&n=" + str(n)
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print("Error:", str(e)[:200])
        return
    results = data.get("results", [])
    if not results:
        print("No results")
        return
    for i, r in enumerate(results):
        dist = r.get("distance", "?")
        print("--- Result " + str(i+1) + " (distance: " + str(dist) + ") ---")
        print(r.get("document", "")[:500])
        print()

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        query = input("Query: ")
        search(query)
    elif args[0] == "--main":
        search(" ".join(args[1:]), collection="sessions")
    else:
        search(" ".join(args))
