/** Title, one line of context, the step's content, then its actions. */
export function StepFrame({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-h1">{title}</h1>
        {description && <p className="text-ui text-text-2">{description}</p>}
      </div>
      {children}
      {actions && <div className="flex flex-wrap items-center gap-2 pt-2">{actions}</div>}
    </section>
  );
}
