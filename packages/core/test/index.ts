import { expect, jest } from "@jest/globals";
import { firstValueFrom, skip, take } from "rxjs";
import {
  Bloc,
  CreateBlocProps,
  ErrorHandler,
  EventHandlersObject,
  createBloc,
  EventHandlerFunction,
} from "../src/index";
import test, { describe, beforeEach, afterEach } from "node:test";

// Helper to wait for the next tick (allows Promises/microtasks to resolve)
const tick = () => new Promise((r) => setTimeout(r, 0));

// --- Test Setup ---

// 1. Define simple State and Event types for testing
interface CounterState {
  count: number;
  lastAction?: string;
}

type CounterEvent =
  | { type: "INCREMENT"; amount: number }
  | { type: "DECREMENT" }
  | { type: "SET_ASYNC"; value: number; delay?: number }
  | { type: "THROW_ERROR"; message: string }
  | { type: "UNHANDLED" };

const initialState: CounterState = { count: 0 };

// --- Test Suite ---

describe("createBloc", () => {
  let bloc: Bloc<CounterEvent, CounterState>;
  let mockHandlers: EventHandlersObject<CounterEvent, CounterState>;
  let mockOnError: jest.Mock<ErrorHandler<CounterEvent>>;
  let mockIncrementHandler: jest.Mock<EventHandlerFunction<any, CounterState>>;
  let mockDecrementHandler: jest.Mock<EventHandlerFunction<any, CounterState>>;
  let mockSetAsyncHandler: jest.Mock<EventHandlerFunction<any, CounterState>>;
  let mockThrowErrorHandler: jest.Mock<EventHandlerFunction<any, CounterState>>;

  // Setup before each test
  beforeEach(() => {
    // Create fresh mocks for handlers and error callback
    mockIncrementHandler = jest.fn((event, { update }) => {
      update((s) => ({
        ...s,
        count: s.count + event.amount,
        lastAction: "increment",
      }));
    });
    mockDecrementHandler = jest.fn((event, { update }) => {
      update((s) => ({ ...s, count: s.count - 1, lastAction: "decrement" }));
    });
    mockSetAsyncHandler = jest.fn(async (event, { update }) => {
      await new Promise((r) => setTimeout(r, event.delay ?? 1));
      update({ count: event.value, lastAction: "set_async" });
    });
    mockThrowErrorHandler = jest.fn((event, { update }) => {
      throw new Error(event.message);
    });

    mockHandlers = {
      INCREMENT: mockIncrementHandler, // Use direct function shorthand
      DECREMENT: { handler: mockDecrementHandler }, // Use object shorthand
      SET_ASYNC: {
        handler: mockSetAsyncHandler,
        // transformer: sequential() // Assuming default (concurrent) or import transformers if testing specific concurrency
      },
      THROW_ERROR: mockThrowErrorHandler,
      // No handler for UNHANDLED
    };

    mockOnError = jest.fn();
  });

  // Cleanup after each test
  afterEach(() => {
    // Ensure bloc is closed if it was created in a test
    bloc?.close();
    jest.clearAllMocks();
  });

  // --- Test Cases ---

  test("should initialize with the provided initial state", () => {
    const props: CreateBlocProps<CounterEvent, CounterState> = {
      initialState,
      handlers: {}, // No handlers needed for this test
    };
    bloc = createBloc(props);

    expect(bloc.state).toEqual(initialState);
  });

  test("should emit the initial state immediately on state$", async () => {
    const props: CreateBlocProps<CounterEvent, CounterState> = {
      initialState: { count: 5 },
      handlers: {},
    };
    bloc = createBloc(props);

    // Use firstValueFrom to get the first emitted value
    const firstState = await firstValueFrom(bloc.state$);
    expect(firstState).toEqual({ count: 5 });
  });

  test("should expose state$, errors$, state, add, close properties/methods", () => {
    const props: CreateBlocProps<CounterEvent, CounterState> = {
      initialState,
      handlers: {},
    };
    bloc = createBloc(props);

    expect(bloc.state$).toBeDefined();
    expect(typeof bloc.state$.subscribe).toBe("function");
    expect(bloc.errors$).toBeDefined();
    expect(typeof bloc.errors$.subscribe).toBe("function");
    expect(bloc.state).toBeDefined();
    expect(typeof bloc.add).toBe("function");
    expect(typeof bloc.close).toBe("function");
  });

  describe("Event Handling", () => {
    beforeEach(() => {
      // Create the bloc with mock handlers for event tests
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState,
        handlers: mockHandlers,
        onError: mockOnError,
      };
      bloc = createBloc(props);
    });

    test("should call the correct handler for a dispatched event type", () => {
      const event: CounterEvent = { type: "INCREMENT", amount: 3 };
      bloc.add(event);

      // Check which handler was called
      expect(mockIncrementHandler).toHaveBeenCalledTimes(1);
      expect(mockDecrementHandler).not.toHaveBeenCalled();
      expect(mockSetAsyncHandler).not.toHaveBeenCalled();
      expect(mockThrowErrorHandler).not.toHaveBeenCalled();
    });

    test("should pass the correct event payload and context to the handler", () => {
      const event: CounterEvent = { type: "INCREMENT", amount: 5 };
      bloc.add(event);

      expect(mockIncrementHandler).toHaveBeenCalledWith(
        event, // The exact event object
        expect.objectContaining({
          // The context object
          value: initialState, // State *before* the handler runs
          update: expect.any(Function), // The update function
        })
      );
    });

    test("should handle handler defined as object", () => {
      const event: CounterEvent = { type: "DECREMENT" };
      bloc.add(event);

      expect(mockDecrementHandler).toHaveBeenCalledTimes(1);
      expect(mockDecrementHandler).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ value: initialState })
      );
    });

    test("should not call any handler for unhandled event types", () => {
      const event: CounterEvent = { type: "UNHANDLED" };
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {}); // Suppress console warning during test

      bloc.add(event);

      expect(mockIncrementHandler).not.toHaveBeenCalled();
      expect(mockDecrementHandler).not.toHaveBeenCalled();
      expect(mockSetAsyncHandler).not.toHaveBeenCalled();
      expect(mockThrowErrorHandler).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("Bloc: Unhandled event:", event);

      warnSpy.mockRestore();
    });

    test("should process events added before subscription starts (cold source behavior)", () => {
      // Add event before anyone subscribes to state$ (except the internal shareReplay)
      bloc.add({ type: "INCREMENT", amount: 1 });

      // Now subscribe and check
      const subscriber = jest.fn();
      bloc.state$.subscribe(subscriber);

      // The subscriber should get initial state AND the updated state
      expect(subscriber).toHaveBeenCalledWith(initialState);
      expect(subscriber).toHaveBeenCalledWith({
        count: 1,
        lastAction: "increment",
      });
      expect(bloc.state).toEqual({ count: 1, lastAction: "increment" });
    });
  });

  describe("State Updates", () => {
    beforeEach(() => {
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState,
        handlers: mockHandlers,
      };
      bloc = createBloc(props);
    });

    test("should update state when handler calls context.update with new value", async () => {
      const event: CounterEvent = { type: "INCREMENT", amount: 10 };
      bloc.add(event);

      // Allow microtasks/event loop tick for update to propagate
      await tick();

      expect(bloc.state).toEqual({ count: 10, lastAction: "increment" });
    });

    test("should update state when handler calls context.update with updater function", async () => {
      // Set initial state to non-zero for clarity
      bloc = createBloc({ initialState: { count: 5 }, handlers: mockHandlers });
      const event: CounterEvent = { type: "DECREMENT" };
      bloc.add(event);

      await tick();

      expect(bloc.state).toEqual({ count: 4, lastAction: "decrement" });
    });

    test("should emit updated state on state$", async () => {
      const event: CounterEvent = { type: "INCREMENT", amount: 7 };
      const statePromise = firstValueFrom(bloc.state$.pipe(skip(1), take(1))); // Skip initial, take next

      bloc.add(event);

      const newState = await statePromise;
      expect(newState).toEqual({ count: 7, lastAction: "increment" });
    });

    test("should handle asynchronous handlers correctly", async () => {
      const event: CounterEvent = { type: "SET_ASYNC", value: 99, delay: 5 };
      const statePromise = firstValueFrom(bloc.state$.pipe(skip(1), take(1)));

      bloc.add(event);

      // State should not have changed immediately
      expect(bloc.state).toEqual(initialState);

      // Wait for the async handler to complete and state to emit
      const newState = await statePromise;

      expect(mockSetAsyncHandler).toHaveBeenCalledTimes(1);
      expect(newState).toEqual({ count: 99, lastAction: "set_async" });
      expect(bloc.state).toEqual({ count: 99, lastAction: "set_async" });
    });

    test("should not emit state if update results in the same state object reference", async () => {
      const identicalState = { count: 50 };
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState: identicalState,
        handlers: {
          // A handler that calls update with the exact same object
          INCREMENT: (event, { update }) => {
            update(identicalState);
          },
        },
      };
      bloc = createBloc(props);

      const subscriber = jest.fn();
      // Subscribe *after* initial state
      bloc.state$.pipe(skip(1)).subscribe(subscriber);

      bloc.add({ type: "INCREMENT", amount: 1 }); // Trigger the handler

      await tick(); // Allow potential update

      expect(subscriber).not.toHaveBeenCalled(); // Should not emit because state === identicalState
      expect(bloc.state).toBe(identicalState); // State reference should be the same
    });

    test("should emit state if update results in a new object with same values", async () => {
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState: { count: 50 },
        handlers: {
          INCREMENT: (event, { update }) => {
            update((s) => ({ ...s })); // Create new object with same values
          },
        },
      };
      bloc = createBloc(props);

      const subscriber = jest.fn();
      bloc.state$.pipe(skip(1)).subscribe(subscriber);

      bloc.add({ type: "INCREMENT", amount: 1 });

      await tick();

      expect(subscriber).toHaveBeenCalledTimes(1); // Should emit because it's a new object reference
      expect(subscriber).toHaveBeenCalledWith({ count: 50 });
      expect(bloc.state).toEqual({ count: 50 });
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState,
        handlers: mockHandlers,
        onError: mockOnError,
      };
      bloc = createBloc(props);
    });

    test("should call onError callback when a handler throws an error", async () => {
      const event: CounterEvent = {
        type: "THROW_ERROR",
        message: "Test error",
      };
      const expectedError = new Error("Test error");

      bloc.add(event);
      await tick(); // Allow handler execution

      expect(mockThrowErrorHandler).toHaveBeenCalledTimes(1);
      expect(mockOnError).toHaveBeenCalledTimes(1);
      // Check error message and event passed to onError
      expect(mockOnError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expectedError.message }),
        event
      );
      // State should likely remain unchanged or reflect state before error
      expect(bloc.state).toEqual(initialState);
    });

    test("should emit on errors$ stream when a handler throws an error", async () => {
      const event: CounterEvent = {
        type: "THROW_ERROR",
        message: "Stream error",
      };
      const expectedError = new Error("Stream error");
      const errorPromise = firstValueFrom(bloc.errors$); // Get the first error emitted

      bloc.add(event);

      const emittedError = await errorPromise;

      expect(emittedError).toBeDefined();
      expect(emittedError.event).toBe(event);
      expect(emittedError.error).toBeInstanceOf(Error);
      expect((emittedError.error as Error).message).toBe(expectedError.message);
    });

    test("should continue processing subsequent events after a handler error", async () => {
      const errorEvent: CounterEvent = {
        type: "THROW_ERROR",
        message: "Fail first",
      };
      const successEvent: CounterEvent = { type: "INCREMENT", amount: 2 };

      // Subscribe to state changes after initial state
      const statePromise = firstValueFrom(bloc.state$.pipe(skip(1)));

      bloc.add(errorEvent); // This will call onError and emit on errors$
      bloc.add(successEvent); // This should still be processed

      // Wait for the successful event's state change
      const newState = await statePromise;

      expect(mockOnError).toHaveBeenCalledTimes(1); // Error handler called once
      expect(mockIncrementHandler).toHaveBeenCalledTimes(1); // Success handler also called
      expect(newState).toEqual({ count: 2, lastAction: "increment" }); // State updated by successful handler
      expect(bloc.state).toEqual({ count: 2, lastAction: "increment" });
    });
  });

  describe("Concurrency (Basic Check - Default Concurrent)", () => {
    beforeEach(() => {
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState,
        // Use async handler to test overlap potential
        handlers: {
          SET_ASYNC: mockSetAsyncHandler,
        },
      };
      bloc = createBloc(props);
    });

    test("should start processing second event even if first async handler is running (concurrent default)", async () => {
      const event1: CounterEvent = { type: "SET_ASYNC", value: 1, delay: 20 };
      const event2: CounterEvent = { type: "SET_ASYNC", value: 2, delay: 10 };

      const firstStatePromise = firstValueFrom(
        bloc.state$.pipe(skip(1), take(1))
      );
      const secondStatePromise = firstValueFrom(
        bloc.state$.pipe(skip(2), take(1))
      );

      bloc.add(event1);
      // Add second event almost immediately, before first handler finishes
      await tick(); // Minimal delay
      bloc.add(event2);

      // With concurrent, event2 handler starts while event1 handler is delayed.
      // Since event2 has a shorter delay, it should finish first.
      const firstEmit = await firstStatePromise;
      expect(firstEmit).toEqual({ count: 2, lastAction: "set_async" }); // Expect state from event 2 first
      expect(bloc.state).toEqual({ count: 2, lastAction: "set_async" });

      // Then event1 finishes and updates state
      const secondEmit = await secondStatePromise;
      expect(secondEmit).toEqual({ count: 1, lastAction: "set_async" }); // Expect state from event 1 second
      expect(bloc.state).toEqual({ count: 1, lastAction: "set_async" });

      expect(mockSetAsyncHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe("Cleanup", () => {
    let stateCompleteFn: jest.Mock<() => void>;
    let errorCompleteFn: jest.Mock<() => void>;

    beforeEach(() => {
      const props: CreateBlocProps<CounterEvent, CounterState> = {
        initialState,
        handlers: mockHandlers,
      };
      bloc = createBloc(props);
      stateCompleteFn = jest.fn();
      errorCompleteFn = jest.fn();
      // Subscribe to check completion
      bloc.state$.subscribe({ complete: stateCompleteFn });
      bloc.errors$.subscribe({ complete: errorCompleteFn });
    });

    test("should complete state$ and errors$ observables on close", () => {
      expect(stateCompleteFn).not.toHaveBeenCalled();
      expect(errorCompleteFn).not.toHaveBeenCalled();

      bloc.close();

      expect(stateCompleteFn).toHaveBeenCalledTimes(1);
      expect(errorCompleteFn).toHaveBeenCalledTimes(1);
    });

    test("should stop processing events after close", async () => {
      bloc.close();

      const event: CounterEvent = { type: "INCREMENT", amount: 1 };
      bloc.add(event);

      await tick(); // Allow potential processing

      expect(mockIncrementHandler).not.toHaveBeenCalled();
    });

    test("should prevent state updates after close", async () => {
      const initial = bloc.state;
      // Get access to an update function *before* closing
      let capturedUpdate:
        | ((state: CounterState) => CounterState)
        | CounterState
        | undefined;
      const tempBloc = createBloc<CounterEvent, CounterState>({
        initialState,
        handlers: {
          INCREMENT: (e, { update }) => {
            capturedUpdate = (s) => ({ ...s, count: s.count + 1 });
          },
        },
      });
      tempBloc.add({ type: "INCREMENT", amount: 1 });
      tempBloc.close(); // Close the temp bloc

      expect(capturedUpdate).toBeDefined();

      // Now close the main bloc
      bloc.close();
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      // Attempt update via captured function (this simulates an async handler completing late)
      if (typeof capturedUpdate === "function") {
        // This internal update function is captured from the closure, we can't call it directly
        // Instead, let's just try adding an event
        bloc.add({ type: "INCREMENT", amount: 99 });
      }

      await tick();

      expect(warnSpy).toHaveBeenCalledWith(
        "Bloc: Attempted to add event after closed."
      );
      expect(bloc.state).toBe(initial); // State should not have changed
      expect(mockIncrementHandler).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
