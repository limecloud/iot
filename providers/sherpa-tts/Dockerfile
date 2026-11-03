FROM python:3.14.7-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY providers/sherpa-tts/requirements.txt /app/requirements.txt
RUN pip install --only-binary=:all: --no-cache-dir --disable-pip-version-check -r /app/requirements.txt
COPY providers/local_process.py /app/providers/local_process.py
COPY providers/sherpa-tts/server.py /app/providers/sherpa-tts/server.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 65532:65532
ENTRYPOINT ["python", "-I", "/app/providers/sherpa-tts/server.py"]
CMD ["--config", "/config/provider.json", "--model-directory", "/models", "--listen", "0.0.0.0", "--allowed-host", "speech:8000", "--allowed-host", "127.0.0.1:8000"]
