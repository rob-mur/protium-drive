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

  @id:a-sign-in-link-that-times-out-is-replaced-by-a-new-one
  Scenario: A sign-in link that times out is replaced by a new link, which signs the user in
    Given the user has not signed in
    When the user signs in after the first sign-in link times out
    Then signing in prints 2 different sign-in links, exits 0, and the state directory holds "session.json"

  @id:signing-in-stops-after-three-sign-in-links-time-out
  Scenario: Signing in stops after three sign-in links time out, as Proton's own apps do
    Given the user has not signed in
    When the user starts signing in, and 3 sign-in links time out unapproved
    Then signing in prints 3 different sign-in links, exits 1, and the state directory holds no "session.json"
