// src/components/ui/sonner.tsx
import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = 'system'; // Default to system theme without next-themes

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:[background:hsl(187_47%_82%)] group-[.toaster]:hover:[background:hsl(187_47%_78%)] dark:group-[.toaster]:[background:hsl(var(--popover))] dark:group-[.toaster]:hover:[background:hsl(var(--card))]',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground group-[.toast]:hover:bg-primary/90',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground group-[.toast]:hover:bg-muted/80',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
