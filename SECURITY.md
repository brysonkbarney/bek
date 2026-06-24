# Security Policy

Bek is an agent control plane. Security bugs can become data leaks or unintended side effects.

Please report vulnerabilities privately to the maintainers before public disclosure.

## Security Invariants

- One visible agent handle does not mean one omnipotent principal.
- Every run is scoped by human, place, agent, capability, credential, and budget.
- Runtimes receive capabilities, not long-lived secrets.
- Tool calls go through policy and audit.
- Writes require approval unless an admin explicitly configures otherwise.
- Sandbox execution must not receive raw provider keys.
- Memory retrieval must enforce ACLs before context injection.

## Not Yet Production Hardened

This early repo includes the product spine and tests, but production use still requires real OAuth apps, persistent storage wiring, hardened sandboxing, tenant isolation review, and external security review.
