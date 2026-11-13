@capability:session-status
Feature: The sign-in status and signing out

  @id:sign-out-removes-the-session
  Scenario: Signing out removes the saved session
    Given the user has signed in
    When the user signs out
    Then the binary says Proton keeps the session until it expires, and the state directory holds no "session.json"

  @id:only-the-user-can-read-the-saved-session
  Scenario: Only the user who signed in can read the saved session
    Given the user has not signed in
    When the user signs in
    Then the state directory holds "session.json" with mode 0600, and the state directory has mode 0700
