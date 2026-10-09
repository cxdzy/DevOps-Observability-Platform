FROM python:3.12-slim

WORKDIR /app

COPY explainer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY explainer/explainer.py .

# Chroma stores its data in /data/chroma; its small ONNX embedding model is cached under /root/.cache.
CMD ["python", "-u", "explainer.py"]
