import type { UiContent } from "@/events/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Renders structured output from the access layer. Content is plain text, never HTML. */
export function OutputCard({ content }: { content: UiContent }) {
  if (content.type === "text") {
    return <p className="text-sm whitespace-pre-wrap">{content.text}</p>;
  }
  return (
    <div className="rounded-lg border bg-card text-sm">
      {content.title && <div className="border-b px-4 py-2.5 font-medium">{content.title}</div>}
      {content.type === "list" ? (
        <ul className="divide-y px-4 py-1.5">
          {content.items.map((item, index) => (
            <li key={index} className="py-1.5 font-mono break-all">
              {item}
            </li>
          ))}
        </ul>
      ) : content.type === "keyValue" ? (
        <dl className="divide-y px-4 py-1.5">
          {content.rows.map((row, index) => (
            <div key={index} className="grid grid-cols-[9rem_1fr] gap-3 py-1.5">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="font-mono break-all">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {content.columns.map((column) => (
                <TableHead key={column}>{column}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {content.rows.map((row, index) => (
              <TableRow key={index}>
                {row.map((cell, cellIndex) => (
                  <TableCell key={cellIndex} className="font-mono">
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
