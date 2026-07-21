# Commercial Launch Checklist

## Completed in this repository

- Product positioning and paid-pilot offer
- Public landing page source
- Privacy and terms drafts
- First-run product onboarding
- Always-on Windows behavior and health status
- Local activation and acceptance metrics
- Automated tests, RAG smoke test, dependency audit, and packaging workflow
- Windows installer configuration
- Support and security documentation

## Owner actions required before accepting payment

- [x] Identify the individual seller as Ramakrishna Chowdary, India
- [x] Add the support and privacy email `ramakrishna.chowdary2005@gmail.com`
- [ ] Have counsel review `PRIVACY.md`, `TERMS.md`, licensing, tax, and refund obligations
- [ ] Buy a Windows Authenticode code-signing certificate and configure CI secrets
- [x] Configure UPI ID `8008874541@ybl` for written pilot invoices
- [ ] Publish final prices, taxes, billing period, cancellation, and refund terms
- [ ] Register a domain and deploy `site/`
- [ ] Create a public GitHub repository or private download portal
- [ ] Upload a 60–90 second demo to YouTube, Vimeo, or Youku
- [ ] Test the signed installer on a clean Windows 10 and Windows 11 machine
- [ ] Recruit 5 pilot teams and obtain written testimonial permission
- [ ] Define support hours, response targets, backup, and incident response

## Release gate

Do not market the build as enterprise-ready until code signing, identity, legal review, clean-machine testing, and a documented support channel are complete.
