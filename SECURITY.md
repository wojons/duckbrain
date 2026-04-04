# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible
receiving such patches depend on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

Please report security vulnerabilities by emailing the maintainers at:

**security@duckbrain.dev** (placeholder - update with actual contact)

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a timeline for
resolution.

## Security Best Practices

When using DuckBrain:

### API Authentication
- Always use strong, unique API tokens
- Rotate tokens regularly
- Store tokens securely (environment variables, not in code)
- Enable rate limiting in production

### Data Storage
- Secure your data directory with appropriate file permissions
- Enable Git encryption for sensitive data
- Regular backups of your memory data
- Use encrypted storage for sensitive information

### Network Security
- Run HTTP API behind a reverse proxy (nginx, Caddy)
- Use HTTPS in production
- Restrict API access with firewall rules
- Monitor access logs for suspicious activity

### Docker Deployment
```bash
# Run as non-root user
docker run -u 1000:1000 duckbrain:latest

# Use read-only filesystem
docker run --read-only duckbrain:latest

# Limit capabilities
docker run --cap-drop=ALL duckbrain:latest
```

## Known Security Considerations

1. **API Tokens**: By default, tokens are not required. Enable authentication
   in production by setting `DUCKBRAIN_API_TOKEN`.

2. **Memory Data**: Stored as plain JSONL files. Encrypt sensitive data before
   storing.

3. **Git Integration**: Pushing to remote repos may expose data. Use private
   repos and encryption.

4. **Vector Search**: Embeddings may leak semantic information. Avoid storing
   highly sensitive data in vector search.

## Disclosure Policy

When we receive a security bug report, we will:

1. Confirm the problem and determine affected versions
2. Audit code to find any similar problems
3. Prepare fixes for all supported versions
4. Release new versions as quickly as possible

We will publicly disclose the issue after giving users time to upgrade.
