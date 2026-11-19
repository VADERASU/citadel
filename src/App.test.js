import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

jest.mock('react-pdf', () => ({ pdfjs: { GlobalWorkerOptions: {} } }));
jest.mock('./components/pdfContainer', () => ({ PDFContainer: () => null }));
jest.mock('./components/visContainer', () => ({
    VisContainer: () => <div>Citation analysis results</div>,
}));
jest.mock('./components/visContainer/overviewCard', () => ({ OverviewCard: () => null }));

test('shows live progress and coverage gaps, then opens the analysis results', async () => {
    const originalFetch = global.fetch;
    const originalWebSocket = global.WebSocket;
    const originalMatchMedia = window.matchMedia;
    global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'Manuscript', authors: ['A. Reader'], year: 2025 }),
    });
    window.matchMedia = () => ({
        matches: false,
        addListener: jest.fn(),
        removeListener: jest.fn(),
    });
    let socket;
    global.WebSocket = class {
        static OPEN = 1;
        readyState = 1;
        send = jest.fn();
        close = jest.fn();

        constructor() {
            socket = this;
        }

        receive(data) {
            act(() => this.onmessage({ data: JSON.stringify(data) }));
        }
    };

    try {
        const { container } = render(<App />);
        const pdf = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' });
        pdf.arrayBuffer = async () => new ArrayBuffer(3);
        fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [pdf] } });
        const submit = await screen.findByRole('button', { name: 'Analyze Paper' });
        await waitFor(() => expect(submit).toBeEnabled());
        fireEvent.click(submit);

        expect(screen.getByText('Connecting to server…')).toBeVisible();
        await act(async () => socket.onopen());
        expect(socket.send).toHaveBeenCalledTimes(3);

        socket.receive({ type: 'info', msg: 'Assessing citation relevance…' });
        socket.receive({ type: 'progress', msg: 'Assessing citation context 2 of 6.' });
        socket.receive({ type: 'warning', msg: 'Some cited papers are missing abstracts.' });
        expect(screen.getByText('Assessing citation relevance…')).toBeVisible();
        expect(screen.getByText('Assessing citation context 2 of 6.')).toBeVisible();

        socket.receive({ type: 'info', msg: 'Checking reported statistical tests…' });
        expect(screen.getByText('Some cited papers are missing abstracts.')).toBeVisible();
        expect(screen.queryByText('Assessing citation context 2 of 6.')).toBeNull();

        socket.receive({ type: 'error', msg: 'Analysis failed. Please try again.' });
        act(() => socket.onclose({ reason: 'Connection closed' }));
        expect(screen.getByText('Analysis failed. Please try again.')).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Analyze Paper' }));
        expect(screen.queryByText('Some cited papers are missing abstracts.')).toBeNull();
        expect(screen.queryByText('Analysis failed. Please try again.')).toBeNull();

        socket.receive({
            type: 'end',
            results: {
                citations: [], authors: [], venues: [],
                anomalous: { identifiedIssue: [] }, authorGraph: null,
            },
        });
        act(() => socket.onclose({ reason: '' }));
        expect(screen.getByText('Citation analysis results')).toBeVisible();
    } finally {
        global.fetch = originalFetch;
        global.WebSocket = originalWebSocket;
        window.matchMedia = originalMatchMedia;
    }
});
