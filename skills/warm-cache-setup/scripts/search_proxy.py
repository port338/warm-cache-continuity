#!/usr/bin/env python3
"""HTTP proxy for ChromaDB semantic search. Deploy as systemd service on the main host host.

GET /?q=<query>&c=<collection>&n=<n_results>
Returns JSON: {"results": [{"distance": float, "document": str, "source": str}]}
"""
from http.server import HTTPServer, BaseHTTPRequestHandler
import json, urllib.parse
import chromadb

client = chromadb.HttpClient(host="localhost", port=8000)

class SearchHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        query = params.get("q", [""])[0]
        collection = params.get("c", ["sessions"])[0]
        n = int(params.get("n", ["5"])[0])
        
        if not query:
            self.send_json({"error": "missing q parameter"})
            return
        
        try:
            col = client.get_collection(collection)
            results = col.query(query_texts=[query], n_results=n)
            docs = results.get("documents", [[]])[0]
            dists = results.get("distances", [[]])[0]
            metas = results.get("metadatas", [[]])[0]
            items = []
            for i in range(len(docs)):
                items.append({
                    "distance": round(dists[i], 3) if i < len(dists) else None,
                    "document": docs[i][:1000],
                    "source": metas[i].get("source", "") if i < len(metas) else ""
                })
            self.send_json({"results": items})
        except Exception as e:
            self.send_json({"error": str(e)[:200]})
    
    def send_json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
    
    def log_message(self, format, *args):
        pass

if __name__ == "__main__":
    print("Search proxy on :8010")
    HTTPServer(("127.0.0.1", 8010), SearchHandler).serve_forever()
