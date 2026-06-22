// src/components/ui/sonner.tsx
import { Toaster as Sonner } from 'sonner';
import { useTheme } from 'next-themes';

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme();
  const theme = (resolvedTheme === 'dark' ? 'dark' : 'light') as ToasterProps['theme'];

  return (
    <Sonner
      position="bottom-left"
      theme={theme}
      className="toaster group"
      expand={true}
      visibleToasts={6}
      gap={8}
      toastOptions={{
        classNames: {
          // Semi-transparent background + backdrop blur: the toast lets the
          // page show through faintly while the blur keeps the text legible
          // over busy content. 0.85 alpha on the card/accent surface colors;
          // tune the /_0.85 value to taste. (The underscore is Tailwind's
          // space escape inside an arbitrary value → "hsl(var(--card) / 0.85)".)
          toast:
            'group toast group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:backdrop-blur-md group-[.toaster]:[background:hsl(var(--card)_/_0.85)] group-[.toaster]:hover:[background:hsl(var(--accent)_/_0.85)]',
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
