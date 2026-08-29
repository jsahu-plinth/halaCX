export const previewCalls = [
  { id: "preview-1", caller_name: "Yousef Khan", from_number: "+971 50 218 4431", direction: "inbound", status: "completed", outcome: "Qualified lead", duration_seconds: 198, created_at: new Date().toISOString(), summary: "Dental clinic owner evaluating after-hours coverage and appointment intake for a Business Bay location." },
  { id: "preview-2", caller_name: "Rania Mansour", from_number: "+971 55 804 1390", direction: "inbound", status: "completed", outcome: "Appointment booked", duration_seconds: 106, created_at: new Date(Date.now() - 7_200_000).toISOString(), summary: "Booked a consultation for Tuesday at 3:30 PM and sent confirmation." },
  { id: "preview-3", caller_name: "Omar Alvi", from_number: "+971 52 601 7724", direction: "outbound", status: "completed", outcome: "Follow-up", duration_seconds: 151, created_at: new Date(Date.now() - 86_400_000).toISOString(), summary: "Requested a proposal by email and a follow-up call next week." },
];

export const previewKnowledge = [
  { id: "knowledge-1", title: "Services and pricing", source_type: "text", status: "active", updated_at: new Date().toISOString() },
  { id: "knowledge-2", title: "Opening hours", source_type: "schedule", status: "active", updated_at: new Date().toISOString() },
  { id: "knowledge-3", title: "Lead qualification", source_type: "workflow", status: "active", updated_at: new Date().toISOString() },
];
