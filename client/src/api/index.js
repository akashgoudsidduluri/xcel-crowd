import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const apiClient = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
});

// Jobs
export const getJobs = () => apiClient.get('/jobs');
export const createJob = (title, capacity, created_by) =>
  apiClient.post('/jobs', { title, capacity, created_by });
export const getJob = (id) => apiClient.get(`/jobs/${id}`);
export const getJobPipeline = (id) => apiClient.get(`/jobs/${id}/pipeline`);

// Applicants
export const getApplicants = () => apiClient.get('/applicants');
export const createApplicant = (name, email) =>
  apiClient.post('/applicants', { name, email });
export const getApplicant = (id) => apiClient.get(`/applicants/${id}`);

// Applications
export const createApplication = (name, email, jobId) =>
  apiClient.post('/applications', { name, email, job_id: jobId });
export const getApplication = (id) => apiClient.get(`/applications/${id}`);
export const acknowledgeApplication = (id) =>
  apiClient.post(`/applications/${id}/ack`);
export const exitApplication = (id, outcome) =>
  apiClient.post(`/applications/${id}/exit`, { outcome });

export default apiClient;
