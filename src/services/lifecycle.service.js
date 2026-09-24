// Full audit trail: client added → design → installation — merged in chronological order.
import { Client, Design, Project } from '../models/index.js';
import { notFound } from '../utils/HttpError.js';
import { objectId } from '../utils/validators.js';

function row(log, phase, id) {
  return {
    id: id || `${phase}-${log.at}-${log.action}`,
    at: log.at,
    action: log.action,
    phase,
    stepName: log.stepName || '',
    byName: log.byName || '',
    byRole: log.byRole || '',
    message: log.message || '',
    lat: log.lat ?? null,
    lng: log.lng ?? null,
    imageUrl: log.imageUrl || '',
  };
}

/**
 * `forAgent`: what a field agent may see of a job they hold a step in — the installation timeline, the design's name
 * and status and the client's name. No pricing summary, client contact details or design/client history.
 */
export async function getLifecycle(companyId, designId, { forAgent = false } = {}) {
  const design = await Design.findOne({ _id: objectId(designId, 'Design'), company: companyId }).populate('client', 'name email phone');
  if (!design) throw notFound('Design');

  const project = await Project.findOne({ design: design._id });
  const clientId = design.client?._id || design.client;
  const clientDoc = clientId ? await Client.findOne({ _id: clientId, company: companyId }) : null;
  const events = [];

  if (forAgent) {
    (project?.logs || []).forEach((l, i) => events.push(row(l, 'installation', `p-${i}`)));
    events.sort((a, b) => new Date(a.at) - new Date(b.at));
    return {
      design: { id: design.id, name: design.name, status: design.status },
      client: design.client ? { name: design.client.name } : null,
      installation: project ? { id: project.id, status: project.status, startedAt: project.createdAt } : null,
      events,
    };
  }

  const clientLogs = clientDoc?.logs || [];
  const hasClientCreated = clientLogs.some((l) => l.action === 'client_created');
  if (clientDoc && !hasClientCreated) {
    events.push({
      id: 'legacy-client',
      at: clientDoc.createdAt,
      action: 'client_created',
      phase: 'client',
      stepName: '',
      byName: '',
      byRole: '',
      message: clientDoc.name,
      lat: null,
      lng: null,
      imageUrl: '',
    });
  }
  clientLogs.forEach((l, i) => events.push(row(l, 'client', `c-${i}`)));

  const designLogs = design.logs || [];
  const hasCreated = designLogs.some((l) => l.action === 'design_created');
  if (!hasCreated) {
    events.push({
      id: 'legacy-created',
      at: design.createdAt,
      action: 'design_created',
      phase: 'design',
      stepName: '',
      byName: '',
      byRole: '',
      message: design.name,
      lat: null,
      lng: null,
      imageUrl: '',
    });
  }
  designLogs.forEach((l, i) => events.push(row(l, 'design', `d-${i}`)));

  if (project) {
    (project.logs || []).forEach((l, i) => events.push(row(l, 'installation', `p-${i}`)));
  }

  events.sort((a, b) => new Date(a.at) - new Date(b.at));

  return {
    design: {
      id: design.id,
      name: design.name,
      status: design.status,
      createdAt: design.createdAt,
      summary: design.summary,
    },
    client: design.client,
    installation: project ? { id: project.id, status: project.status, startedAt: project.createdAt } : null,
    events,
  };
}

export async function getLifecycleForProject(companyId, projectId, options) {
  const project = await Project.findOne({ _id: objectId(projectId, 'Installation'), company: companyId });
  if (!project) throw notFound('Installation');
  return getLifecycle(companyId, project.design, options);
}
