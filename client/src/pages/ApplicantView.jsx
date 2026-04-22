import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  getApplication,
  acknowledgeApplication,
  exitApplication,
} from '../api/index';
import '../styles/ApplicantView.css';

export default function ApplicantView() {
  const { applicationId } = useParams();
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadApplication();
    const interval = setInterval(loadApplication, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, [applicationId]);

  const loadApplication = async () => {
    try {
      setLoading(true);
      const response = await getApplication(applicationId);
      setApplication(response.data);
      setError(null);
    } catch (err) {
      setError(`Failed to load application: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleAcknowledge = async () => {
    try {
      setUpdating(true);
      setError(null);
      await acknowledgeApplication(applicationId);
      await loadApplication();
      setMessage('Application successfully acknowledged.');
    } catch (err) {
      setError(`Error acknowledging: ${err.message}`);
    } finally {
      setUpdating(false);
    }
  };

  const handleExit = async (outcome) => {
    if (!window.confirm(`Are you sure you want to mark this application as ${outcome}?`)) {
      return;
    }

    try {
      setUpdating(true);
      setError(null);
      await exitApplication(applicationId, outcome);
      await loadApplication();
      setMessage(`Application marked as ${outcome}`);
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setUpdating(false);
    }
  };

  if (loading && !application) {
    return <div className="loading">Loading application...</div>;
  }

  if (error && !application) {
    return <div className="error">{error}</div>;
  }

  if (!application) {
    return <div className="error">Application not found</div>;
  }

  const formatDate = (date) => {
    return date ? new Date(date).toLocaleString() : 'N/A';
  };

  const isExpiringSoon =
    application.ack_deadline &&
    new Date(application.ack_deadline) - new Date() < 60 * 60 * 1000; // < 1 hour

  return (
    <div className="applicant-view">
      {message && <div style={{background: '#e8f5e9', color: '#2e7d32', padding: '10px', marginBottom: '15px', borderRadius: '4px'}}>{message}</div>}
      <header className="applicant-header">
        <h1>{application.name}</h1>
        <p className="email">{application.email}</p>
      </header>

      <div className="applicant-details">
        <section className="detail-section">
          <h2>Application Status</h2>
          <div className={`status-badge status-${application.status.toLowerCase()}`}>
            {application.status}
          </div>
        </section>

        <section className="detail-section">
          <h2>Timeline</h2>
          <dl>
            <dt>Applied:</dt>
            <dd>{formatDate(application.created_at)}</dd>
            <dt>Last Updated:</dt>
            <dd>{formatDate(application.last_transition_at)}</dd>
          </dl>
        </section>

        {application.status === 'ACTIVE' && (
          <section className="detail-section">
            <h2>Acknowledgment</h2>
            <dl>
              <dt>Deadline:</dt>
              <dd className={isExpiringSoon ? 'expiring-soon' : ''}>
                {formatDate(application.ack_deadline)}
                {isExpiringSoon && <span className="warning">⚠️ Expiring soon!</span>}
              </dd>
            </dl>
            <button
              className="btn btn-secondary"
              onClick={handleAcknowledge}
              disabled={updating}
            >
              {updating ? 'Updating...' : 'Acknowledge'}
            </button>
          </section>
        )}

        {application.status === 'WAITLISTED' && (
          <section className="detail-section">
            <h2>Queue Position</h2>
            <div className="queue-position">
              Position: <strong>#{application.queue_position}</strong>
            </div>
          </section>
        )}

        {application.status === 'ACTIVE' && (
          <section className="detail-section actions">
            <h2>Actions</h2>
            <button
              className="btn btn-success"
              onClick={() => handleExit('HIRED')}
              disabled={updating}
            >
              {updating ? 'Processing...' : 'Mark as Hired'}
            </button>
            <button
              className="btn btn-danger"
              onClick={() => handleExit('REJECTED')}
              disabled={updating}
            >
              {updating ? 'Processing...' : 'Reject'}
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
