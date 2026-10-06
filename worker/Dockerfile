FROM python:3.12-slim

WORKDIR /app

COPY worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The worker reuses the feature engineering of the training script, so both
# always compute the same features.
COPY scripts/train_anomaly_model.py .
COPY worker/worker.py .

CMD ["python", "-u", "worker.py"]
