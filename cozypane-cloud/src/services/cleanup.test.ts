import { describe, it, expect, vi } from 'vitest';
import { cleanupDeployment, type DeploymentForCleanup } from './cleanup.js';

// Mock the sub-functions
vi.mock('./container.js', () => ({
  stopContainer: vi.fn().mockResolvedValue(undefined),
  removeImage: vi.fn().mockResolvedValue(undefined),
  removeNetworkIfEmpty: vi.fn().mockResolvedValue(undefined),
  docker: {},
}));

vi.mock('./database.js', () => ({
  dropDatabase: vi.fn().mockResolvedValue(undefined),
}));

import { stopContainer, removeImage, removeNetworkIfEmpty } from './container.js';
import { dropDatabase } from './database.js';

const mockStop = vi.mocked(stopContainer);
const mockRemoveImage = vi.mocked(removeImage);
const mockRemoveNetwork = vi.mocked(removeNetworkIfEmpty);
const mockDropDb = vi.mocked(dropDatabase);

function makeDeployment(overrides: Partial<DeploymentForCleanup> = {}): DeploymentForCleanup {
  return {
    user_id: 1,
    app_name: 'test-app',
    container_id: 'container123',
    db_name: 'cp_1_test_app',
    ...overrides,
  };
}

describe('cleanupDeployment', () => {
  it('calls all cleanup steps when container and db exist', async () => {
    const dep = makeDeployment();
    const result = await cleanupDeployment(dep);
    expect(result.warnings).toEqual([]);
    expect(mockStop).toHaveBeenCalledWith('container123');
    expect(mockDropDb).toHaveBeenCalledWith(1, 'test-app');
    expect(mockRemoveImage).toHaveBeenCalledWith('cozypane/1-test-app:latest');
    expect(mockRemoveNetwork).toHaveBeenCalledWith(1);
  });

  it('skips container stop when container_id is null', async () => {
    mockStop.mockClear();
    const dep = makeDeployment({ container_id: null });
    await cleanupDeployment(dep);
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('skips database drop when db_name is null', async () => {
    mockDropDb.mockClear();
    const dep = makeDeployment({ db_name: null });
    await cleanupDeployment(dep);
    expect(mockDropDb).not.toHaveBeenCalled();
  });

  it('skips image removal when removeImageTag=false', async () => {
    mockRemoveImage.mockClear();
    const dep = makeDeployment();
    await cleanupDeployment(dep, { removeImageTag: false });
    expect(mockRemoveImage).not.toHaveBeenCalled();
  });

  it('skips network cleanup when cleanNetwork=false', async () => {
    mockRemoveNetwork.mockClear();
    const dep = makeDeployment();
    await cleanupDeployment(dep, { cleanNetwork: false });
    expect(mockRemoveNetwork).not.toHaveBeenCalled();
  });

  it('collects warnings from failing steps instead of throwing', async () => {
    mockStop.mockRejectedValueOnce(new Error('container not found'));
    mockDropDb.mockRejectedValueOnce(new Error('db connection failed'));
    mockRemoveImage.mockRejectedValueOnce(new Error('image in use'));
    mockRemoveNetwork.mockRejectedValueOnce(new Error('network busy'));

    const dep = makeDeployment();
    const result = await cleanupDeployment(dep);
    expect(result.warnings).toHaveLength(4);
    expect(result.warnings[0]).toContain('stopContainer');
    expect(result.warnings[0]).toContain('container not found');
    expect(result.warnings[1]).toContain('dropDatabase');
    expect(result.warnings[1]).toContain('db connection failed');
    expect(result.warnings[2]).toContain('removeImage');
    expect(result.warnings[2]).toContain('image in use');
    expect(result.warnings[3]).toContain('removeNetworkIfEmpty');
    expect(result.warnings[3]).toContain('network busy');
  });

  it('continues cleanup after partial failures', async () => {
    mockStop.mockRejectedValueOnce(new Error('fail'));
    // dropDatabase, removeImage, removeNetworkIfEmpty should still be called
    mockDropDb.mockClear();
    mockRemoveImage.mockClear();
    mockRemoveNetwork.mockClear();

    const dep = makeDeployment();
    await cleanupDeployment(dep);
    expect(mockDropDb).toHaveBeenCalled();
    expect(mockRemoveImage).toHaveBeenCalled();
    expect(mockRemoveNetwork).toHaveBeenCalled();
  });
});
