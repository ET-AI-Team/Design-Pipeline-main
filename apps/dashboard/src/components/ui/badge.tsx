import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-[11px] font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-colors overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive: 'border-destructive/20 bg-destructive/10 text-destructive [a&]:hover:bg-destructive/15',
        success: 'border-success/20 bg-success/10 text-success [a&]:hover:bg-success/15',
        warning: 'border-warning/25 bg-warning/15 text-warning [a&]:hover:bg-warning/20',
        attention: 'border-attention/25 bg-attention/15 text-attention [a&]:hover:bg-attention/20',
        outline: 'text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span';

  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
