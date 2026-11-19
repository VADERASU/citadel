export const FloatingPanel = ({ anomalous, anomalousColorScheme, setAnomalous }) => {
  const categories = new Map();
  for (const issue of anomalous) {
    const key = `${issue.name}/${issue.category.name}`;
    if (!categories.has(key)) categories.set(key, { issue, count: 0 });
    categories.get(key).count += 1;
  }

  return (
    <div className="review-filters" role="group" aria-label="Filter findings by category">
      {Array.from(categories, ([key, { issue, count }]) => {
        const { name, category, filter } = issue;
        const color = anomalousColorScheme[name].category[category.name].baseColor;
        return (
          <button
            key={key}
            type="button"
            className="review-filter"
            aria-pressed={!filter}
            data-category={category.name}
            style={{ "--finding-color": color }}
            onClick={() => setAnomalous(previous => previous.map(item =>
              item.name === name && item.category.name === category.name ? { ...item, filter: !filter } : item
            ))}
          >
            <span className="review-filter-swatch" aria-hidden="true" />
            {category.displayName} <span className="review-filter-count">{count}</span>
          </button>
        );
      })}
    </div>
  );
};
