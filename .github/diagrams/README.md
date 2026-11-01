# README diagrams

The README pictures are rendered from `readme-system.mmd` and `readme-store-flow.mmd`. Edit the Mermaid source, then render light and dark PNGs into `.github/assets/` with Mermaid CLI at 2× scale.

```sh
mmdc -i .github/diagrams/readme-system.mmd -o .github/assets/system-light.png -c .github/diagrams/mermaid-light.json -b '#FAF8F4' -s 2
mmdc -i .github/diagrams/readme-system.mmd -o .github/assets/system-dark.png -c .github/diagrams/mermaid-dark.json -b '#0B0B0F' -s 2
mmdc -i .github/diagrams/readme-store-flow.mmd -o .github/assets/store-flow-light.png -c .github/diagrams/mermaid-light.json -b '#FAF8F4' -s 2
mmdc -i .github/diagrams/readme-store-flow.mmd -o .github/assets/store-flow-dark.png -c .github/diagrams/mermaid-dark.json -b '#0B0B0F' -s 2
```

Mermaid CLI needs a local Chromium browser. On a machine where Puppeteer cannot find one, pass `-p` with a local Puppeteer config containing its `executablePath`.
