FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependencies first so code changes don't reinstall them.
# hidapi's Linux wheel bundles libudev/libusb, so no apt packages are needed.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY razer_helper.py ./
COPY web ./web

ENV PATH="/app/.venv/bin:$PATH" \
    WEBZER_HOST=0.0.0.0 \
    WEBZER_PORT=8137
EXPOSE 8137

CMD ["python", "razer_helper.py"]
