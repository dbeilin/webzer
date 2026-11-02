FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim@sha256:531f855bda2c73cd6ef67d56b733b357cea384185b3022bd09f05e002cd144ca

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# hidapi's Linux wheel bundles libusb and libudev, so no apt packages are needed.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-install-project

COPY razer_helper.py ./
COPY web ./web

ENV PATH="/app/.venv/bin:$PATH" \
    WEBZER_HOST=0.0.0.0 \
    WEBZER_PORT=8137
EXPOSE 8137

# As PID 1, Python ignores SIGTERM, so docker stop would wait 10 s and then kill it.
# SIGINT raises KeyboardInterrupt, which the helper handles.
STOPSIGNAL SIGINT
CMD ["python", "razer_helper.py"]
