"""
Chroma — Vector Database inspection view
Prints the stored incident embeddings as a readable table, for demo purposes.

Run: python3 view_chroma.py
"""

import os
os.environ["ANONYMIZED_TELEMETRY"] = "False"

import chromadb

client = chromadb.PersistentClient(path="./chroma_data")
collection = client.get_collection("incident_embedding")

data = collection.get(include=["documents", "metadatas"])

print(f"Collection: incident_embedding")
print(f"Total stored incidents: {collection.count()}\n")

for i, (doc_id, doc, meta) in enumerate(
    zip(data["ids"], data["documents"], data["metadatas"]), start=1
):
    print(f"--- Incident {i} ---")
    print(f"  ID:                {doc_id}")
    print(f"  Container:         {meta['container_name']}")
    print(f"  Severity tier:     {meta['severity_tier']}")
    print(f"  Anomaly score:     {meta['anomaly_score']}")
    print(f"  Action taken:      {meta['action_taken']}")
    print(f"  Resolution status: {meta['resolution_status']}")
    print(f"  MTTR (seconds):    {meta['mttr_seconds']}")
    print(f"  Timestamp:         {meta['incident_timestamp']}")
    print(f"  Description:       {doc}")
    print()
