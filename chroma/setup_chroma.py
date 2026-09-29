"""
Chroma — Vector Database
Stores past incident embeddings for RAG retrieval.

Uses all-MiniLM-L6-v2 (384 dimensions), matching the embedding(FLOAT[384])
field in the ERD.

Run: python3 setup_chroma.py
"""

import chromadb
from sentence_transformers import SentenceTransformer

client = chromadb.PersistentClient(path="./chroma_data")
model = SentenceTransformer("all-MiniLM-L6-v2")

collection = client.get_or_create_collection(name="incident_embedding")

incidents = [
    {
        "id": "d1111111-1111-1111-1111-111111111111",
        "document": "CPU usage on api-gateway rose moderately above baseline with no recent deployment detected.",
        "metadata": {
            "anomaly_score": 0.68,
            "severity_tier": "low",
            "container_name": "api-gateway",
            "action_taken": "notified",
            "incident_timestamp": "2026-09-25T14:22:10",
            "mttr_seconds": 0,
            "resolution_status": "monitoring",
        },
    },
    {
        "id": "d2222222-2222-2222-2222-222222222222",
        "document": "Memory usage on auth-service spiked shortly after deployment, consistent with a memory leak in the new build.",
        "metadata": {
            "anomaly_score": 0.79,
            "severity_tier": "medium",
            "container_name": "auth-service",
            "action_taken": "restarted",
            "incident_timestamp": "2026-09-26T09:05:44",
            "mttr_seconds": 45,
            "resolution_status": "resolved",
        },
    },
    {
        "id": "d3333333-3333-3333-3333-333333333333",
        "document": "Request latency on payment-worker degraded sharply immediately after deployment, indicating a regression.",
        "metadata": {
            "anomaly_score": 0.93,
            "severity_tier": "high",
            "container_name": "payment-worker",
            "action_taken": "rolled_back",
            "incident_timestamp": "2026-09-27T21:40:02",
            "mttr_seconds": 120,
            "resolution_status": "resolved",
        },
    },
]

embeddings = model.encode([i["document"] for i in incidents]).tolist()

collection.upsert(
    ids=[i["id"] for i in incidents],
    documents=[i["document"] for i in incidents],
    metadatas=[i["metadata"] for i in incidents],
    embeddings=embeddings,
)

print(f"Stored {collection.count()} incident embeddings.\n")

# Demo similarity search: a new incident, find the closest past match
query = "auth-service memory usage climbing after new build was deployed"
query_embedding = model.encode([query]).tolist()

results = collection.query(query_embeddings=query_embedding, n_results=2)

print(f"Query: {query}\n")
print("Most similar past incidents:")
for doc, meta, dist in zip(
    results["documents"][0], results["metadatas"][0], results["distances"][0]
):
    print(f"\n  Distance: {dist:.4f}")
    print(f"  Container: {meta['container_name']}  |  Tier: {meta['severity_tier']}  |  Action: {meta['action_taken']}")
    print(f"  {doc}")
