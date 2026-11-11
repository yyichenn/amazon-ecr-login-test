import https from 'node:https';

for (const name of ['EXPECT', 'REGISTRY', 'REPOSITORY', 'TAG']) {
  if (!process.env[name]) throw new Error(`Missing ${name}`);
}

const headers = {
  Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
};
if (process.env.ECR_USER || process.env.ECR_PASSWORD) {
  if (!process.env.ECR_USER || !process.env.ECR_PASSWORD) {
    throw new Error('Both ECR_USER and ECR_PASSWORD are required');
  }
  headers.Authorization = `Basic ${Buffer.from(
    `${process.env.ECR_USER}:${process.env.ECR_PASSWORD}`
  ).toString('base64')}`;
}

const status = await new Promise((resolve, reject) => {
  const request = https.get({
    hostname: process.env.REGISTRY,
    path: `/v2/${process.env.REPOSITORY}/manifests/${process.env.TAG}`,
    headers
  }, (response) => {
    response.resume();
    response.on('end', () => resolve(response.statusCode ?? 0));
  });
  request.on('error', reject);
});

console.log(`registry probe status=${status} expected=${process.env.EXPECT}`);
const success = status === 200;
if ((process.env.EXPECT === 'success') !== success) process.exitCode = 1;
