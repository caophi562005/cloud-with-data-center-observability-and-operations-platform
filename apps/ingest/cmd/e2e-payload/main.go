// e2e-payload writes an offline fixture; transport/authentication are deliberately external.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/caonhi562005/cloud-with-data-center-observability-and-operations-platform/apps/ingest/internal/e2epayload"
)

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("e2e-payload", flag.ContinueOnError)
	// flag package errors echo untrusted input; replace them with a redacted diagnostic.
	flags.SetOutput(io.Discard)
	var options e2epayload.Options
	var output string
	flags.StringVar(&options.Kind, "kind", "valid", "fixture kind")
	flags.StringVar(&options.RunID, "run-id", "", "unique nonsecret request marker")
	flags.Int64Var(&options.TimestampMillis, "timestamp-ms", 0, "positive sample timestamp")
	flags.Int64Var(&options.MaxBytes, "max-bytes", 10485760, "body size threshold, 1..67108864")
	flags.StringVar(&options.SpoofOrganizationID, "spoof-org", "", "spoof organization label")
	flags.StringVar(&options.SpoofVMID, "spoof-vm", "", "spoof VM label")
	flags.StringVar(&options.SpoofAgentID, "spoof-agent", "", "spoof agent label")
	flags.StringVar(&output, "output", "", "new output path in a private directory")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || output == "" {
		fmt.Fprintln(stderr, "invalid fixture arguments")
		return 1
	}
	body, err := e2epayload.Build(options)
	if err != nil {
		fmt.Fprintln(stderr, "invalid fixture options")
		return 1
	}
	// EXCL protects existing files and symlinks; Windows confidentiality uses parent ACL.
	file, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		fmt.Fprintln(stderr, "unable to create fixture output")
		return 1
	}
	n, writeErr := file.Write(body)
	closeErr := file.Close()
	if writeErr != nil || n != len(body) || closeErr != nil {
		fmt.Fprintln(stderr, "unable to write fixture output")
		return 1
	}
	if _, err := fmt.Fprintf(stdout, "kind=%s bytes=%d\n", options.Kind, n); err != nil {
		fmt.Fprintln(stderr, "unable to report fixture output")
		return 1
	}
	return 0
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
