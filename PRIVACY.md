# Prompt Optimizer Privacy Notice

Effective date: July 21, 2026

Prompt Optimizer is a Windows desktop application that helps users improve prompts with optional workspace context and local retrieval.

## Data processed

The application may process text that the user enters, clipboard content selected by the user, active-window text, project files, Git status and diffs, and locally learned prompt memory. When a model-backed feature is used, the bounded prompt and context required for that request are sent to the model provider configured by the user.

## Local storage

Configuration, encrypted API credentials, prompt memory, caches, diagnostic logs, and optional usage counters are stored locally under `%USERPROFILE%\.prompt-optimizer`. Product metrics contain counters and dates, not prompt text. Users can disable memory, history, automatic learning, and local metrics, and can clear memory from Settings.

## Third-party processing

The current release uses the Groq API when model-backed optimization is requested. Groq's own terms and privacy policy apply to data sent to its service. Optional IDE integrations may send content to the provider selected by the user. Prompt Optimizer does not sell personal information.

## Security

API credentials are protected with Windows Data Protection API where available. The application redacts common secret patterns, detects prompt-injection indicators, bounds context size, validates generated output, and isolates memory by application and workspace by default. No security control eliminates all risk; users should avoid submitting information they are not authorized to process.

## Retention and deletion

Local data remains on the device until the user clears it or uninstalls the application and removes `%USERPROFILE%\.prompt-optimizer`. Data sent to a third-party model provider is retained according to that provider's policies and the user's account configuration.

## Business customers

Organizations are responsible for configuring approved model providers, retention settings, employee access, and acceptable-use policies. A separate data processing agreement may be required before enterprise deployment.

## Contact

Seller and privacy contact: **Ramakrishna Chowdary, India**  
Email: **ramakrishna.chowdary2005@gmail.com**

For privacy or deletion requests, use the subject line `Prompt Optimizer Privacy Request`. Identity verification may be required before acting on requests involving customer data.

This document is a product-ready starting point and is not legal advice. Obtain review from qualified counsel before accepting paying customers.
