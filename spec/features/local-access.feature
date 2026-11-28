@capability:local-access
Feature: Only the user's own clients reach the Drive through the local port

  @id:a-request-under-a-foreign-name-is-refused
  Scenario: A request that names another site is refused before it reaches the Drive
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    When a web page at evil.example lists "Photos" through the serve's port
    Then the serve refuses the web page as misdirected, and the Drive did not list "Photos"

  @id:the-mount-refuses-a-request-without-its-credential
  Scenario: The mount's port refuses a program that lacks the mount's credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When another program lists "Photos" at the mount's port without the mount's credential
    Then the mount's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:the-mount-keeps-its-credential-off-the-command-line
  Scenario: The mount keeps its credential off every command line
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When another program reads the mount's processes from the process table
    Then rclone holds the mount's credential in its environment, and no command line of the mount's processes holds it

  @id:the-serve-listens-only-on-loopback-by-default
  Scenario: The serve listens only on the loopback address unless the user names another
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve
    And another program reads which addresses the serve's port listens on
    Then the serve's port listens on 127.0.0.1 and on no other address

  @id:a-serve-with-a-credential-file-refuses-a-program-without-it
  Scenario: A serve started with a credential file refuses a program that lacks the credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When another program lists "Photos" at the serve's port without the serve's credential
    Then the serve's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:a-serve-with-a-credential-file-refuses-a-wrong-credential
  Scenario: A serve started with a credential file refuses a program that sends a wrong credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When another program lists "Photos" at the serve's port with a wrong credential
    Then the serve's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:a-serve-with-a-credential-file-answers-a-client-that-sends-it
  Scenario: A serve started with a credential file answers the user's client that sends the credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user keeps the serve's credential in a file only they can read
    When the user lists "Photos"
    Then the listing shows exactly:
      | name      | kind | size |
      | beach.jpg | file | 12   |

  @id:a-serve-refuses-a-credential-file-other-users-can-read
  Scenario: A serve refuses to start with a credential file that other users can read
    Given a Drive whose My files holds the folder "Photos"
    And the user keeps the serve's credential in a file that other users can read
    When the user starts the serve
    Then the serve exits 1 saying "chmod 600"

  @id:a-serve-without-a-credential-file-refuses-a-program-without-its-credential
  Scenario: A serve started without a credential file still refuses a program that lacks the serve's credential
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    When another program lists "Photos" at the serve's port without the serve's credential
    Then the serve's port refuses the program as unauthorised, and the Drive did not list "Photos"

  @id:a-serve-without-a-credential-file-makes-one-only-the-user-can-read
  Scenario: A serve started without a credential file makes its credential in a file only the user can read
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve
    Then the serve made a credential in its state folder, in a file only the user can read

  @id:a-restarted-serve-keeps-the-credential-it-made
  Scenario: A restarted serve keeps the credential it made, so the user's client still reaches it
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    When the user starts the serve
    And the serve restarts
    And the user lists "Photos"
    Then the serve made a credential in its state folder, in a file only the user can read
    And the listing shows exactly:
      | name      | kind | size |
      | beach.jpg | file | 12   |

  @id:a-serve-that-cannot-make-its-credential-file-exits
  Scenario: A serve that cannot make its credential file exits rather than serve without one
    Given a Drive whose My files holds the folder "Photos"
    And the user cannot write to the serve's state folder
    When the user starts the serve
    Then the serve exits 1 saying "cannot be made"

  @id:a-serve-with-no-credential-answers-a-program-on-loopback
  Scenario: A serve the user starts with no credential answers a program on the same computer
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user serves the Drive with no credential
    When another program lists "Photos" at the serve's port without the serve's credential
    Then the serve's port answers the program with the listing of "Photos"

  @id:a-serve-refuses-no-credential-off-loopback
  Scenario: A serve refuses to start with no credential on an address other computers can reach
    Given a Drive whose My files holds the folder "Photos"
    And the user serves the Drive with no credential
    When the user starts the serve on "0.0.0.0"
    Then the serve exits 2 saying "--no-credential is for a serve on loopback only"

  @id:a-serve-refuses-a-credential-file-and-no-credential-together
  Scenario: A serve refuses to start with both a credential file and no credential
    Given a Drive whose My files holds the folder "Photos"
    And the user keeps the serve's credential in a file only they can read
    And the user serves the Drive with no credential
    When the user starts the serve
    Then the serve exits 2 saying "not both"

  @id:a-serve-off-loopback-warns-that-traffic-is-unencrypted
  Scenario: A serve on an address other computers can reach warns that its traffic is not encrypted
    Given a Drive whose My files holds the folder "Photos"
    When the user starts the serve on "0.0.0.0"
    Then the serve warned once "unencrypted", ending "Prefer 127.0.0.1."
