// Global test setup for cozypane-cloud
// Set test environment variables before any imports
process.env.JWT_SECRET = 'test-jwt-secret-for-testing-only';
process.env.GITHUB_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64); // 32-byte hex key
process.env.DOMAIN = 'test.cozypane.com';
process.env.NODE_ENV = 'test';
