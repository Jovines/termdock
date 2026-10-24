import { forwardRef } from 'react';
import { TableHead as NativeTableHead, type TableHeadProps } from '@openuidev/react-ui/Table';
export { ScrollableTable, Table, TableBody, TableCell, TableHeader, TableRow, TableFooter } from '@openuidev/react-ui/Table';
/** Explicit scope keeps headers discoverable across browser accessibility trees. */
export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>((props, ref) => <NativeTableHead {...props} ref={ref} scope={props.scope ?? 'col'} />);
