# Security Policy

## Supported Version

Security fixes are applied to the latest release on the `main` branch.

## Reporting a Vulnerability

Do not include API keys, customer content, conversation history, or proof-of-concept secrets in a public issue. Use GitHub's private vulnerability reporting option when it is available for this repository, or email `ramakrishna.chowdary2005@gmail.com` with the subject `Prompt Optimizer Security Report`.

Before commercial launch, publish an expected acknowledgement time, remediation targets by severity, and a coordinated-disclosure policy.

## Local Data Handling

Prompt Optimizer stores API credentials, local prompt history, and RAG memory outside the source repository. These files are excluded by `.gitignore` and must never be committed.
