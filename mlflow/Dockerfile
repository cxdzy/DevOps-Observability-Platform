FROM python:3.11-slim

RUN pip install --no-cache-dir mlflow==2.17.0 psycopg2-binary==2.9.9

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5000

ENTRYPOINT ["/entrypoint.sh"]
