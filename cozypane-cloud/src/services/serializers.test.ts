import { describe, it, expect } from 'vitest';
import {
  appUrl,
  serializeDeploymentSummary,
  serializeDeploymentDetail,
  DOMAIN,
  type DeploymentRow,
} from './serializers.js';

function makeRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: 1,
    app_name: 'my-app',
    subdomain: 'my-app-abc',
    status: 'running',
    project_type: 'node',
    tier: 'small',
    port: 3000,
    container_id: 'abc123',
    db_name: null,
    deploy_group: null,
    framework: 'express',
    deploy_phase: 'running',
    error_detail: null,
    detected_port: 3000,
    detected_database: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('appUrl', () => {
  it('constructs the correct URL', () => {
    expect(appUrl('my-app-abc')).toBe(`https://my-app-abc.${DOMAIN}`);
  });
});

describe('serializeDeploymentSummary', () => {
  it('maps snake_case DB row to camelCase API shape', () => {
    const row = makeRow();
    const result = serializeDeploymentSummary(row);
    expect(result.id).toBe(1);
    expect(result.appName).toBe('my-app');
    expect(result.subdomain).toBe('my-app-abc');
    expect(result.url).toBe(`https://my-app-abc.${DOMAIN}`);
    expect(result.status).toBe('running');
    expect(result.projectType).toBe('node');
    expect(result.tier).toBe('small');
    expect(result.port).toBe(3000);
    expect(result.hasContainer).toBe(true);
    expect(result.hasDatabase).toBe(false);
    expect(result.databaseType).toBeNull();
    expect(result.databaseName).toBeNull();
    expect(result.framework).toBe('express');
  });

  it('shows database info when db_name is set', () => {
    const row = makeRow({ db_name: 'cp_1_myapp' });
    const result = serializeDeploymentSummary(row);
    expect(result.hasDatabase).toBe(true);
    expect(result.databaseType).toBe('postgres');
    expect(result.databaseName).toBe('cp_1_myapp');
  });

  it('shows hasContainer=false when container_id is null', () => {
    const row = makeRow({ container_id: null });
    const result = serializeDeploymentSummary(row);
    expect(result.hasContainer).toBe(false);
  });

  it('handles null optional fields', () => {
    const row = makeRow({
      deploy_group: null,
      framework: null,
      deploy_phase: null,
      detected_port: null,
      detected_database: null,
    });
    const result = serializeDeploymentSummary(row);
    expect(result.group).toBeNull();
    expect(result.framework).toBeNull();
    expect(result.phase).toBeNull();
    expect(result.detectedPort).toBeNull();
    expect(result.detectedDatabase).toBe(false);
  });
});

describe('serializeDeploymentDetail', () => {
  it('includes all summary fields plus detail fields', () => {
    const row = makeRow({
      username: 'testuser',
      avatar_url: 'https://github.com/testuser.png',
      customDomains: [{ id: 1, domain: 'example.com', verified: true }],
    });
    const result = serializeDeploymentDetail(row);
    // Has summary fields
    expect(result.appName).toBe('my-app');
    // Has detail-only fields
    expect(result.errorDetail).toBeNull();
    expect(result.username).toBe('testuser');
    expect(result.avatarUrl).toBe('https://github.com/testuser.png');
    expect(result.customDomains).toEqual([{ id: 1, domain: 'example.com', verified: true }]);
  });

  it('parses JSON error_detail', () => {
    const row = makeRow({
      error_detail: JSON.stringify({ step: 'build', message: 'OOM' }),
    });
    const result = serializeDeploymentDetail(row);
    expect(result.errorDetail).toEqual({ step: 'build', message: 'OOM' });
  });

  it('falls back to raw string for non-JSON error_detail', () => {
    const row = makeRow({ error_detail: 'Build failed at step 3' });
    const result = serializeDeploymentDetail(row);
    expect(result.errorDetail).toBe('Build failed at step 3');
  });

  it('defaults customDomains to empty array', () => {
    const row = makeRow();
    const result = serializeDeploymentDetail(row);
    expect(result.customDomains).toEqual([]);
  });
});
