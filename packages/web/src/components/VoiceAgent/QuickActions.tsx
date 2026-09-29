export type QuickAction = {
  id: string;
  label: string;
  utterance: string;
};

const DEFAULT_ACTIONS: QuickAction[] = [
  {
    id: "weather",
    label: "Weather",
    utterance: "What is the weather in Stockholm?",
  },
  {
    id: "reminder",
    label: "Reminder",
    utterance: "Remind me to follow up with the recruiter tomorrow",
  },
  {
    id: "translate",
    label: "Translate",
    utterance: "Translate hello world in swedish",
  },
  {
    id: "summarize",
    label: "Summarize",
    utterance: "Summarize: we shipped the API, fixed the tests, and wrote the docs.",
  },
  {
    id: "help",
    label: "Help",
    utterance: "Help",
  },
];

export type QuickActionsProps = {
  onAction: (utterance: string) => void;
  disabled?: boolean;
  actions?: QuickAction[];
};

export function QuickActions({
  onAction,
  disabled = false,
  actions = DEFAULT_ACTIONS,
}: QuickActionsProps) {
  return (
    <div
      role="group"
      aria-label="Quick actions"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        marginBottom: "0.85rem",
      }}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="prompt-chip"
          disabled={disabled}
          onClick={() => onAction(action.utterance)}
          title={action.utterance}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
